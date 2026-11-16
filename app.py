import os, base64, io, qrcode, time, json
from urllib.parse import urlencode
from flask import Flask, make_response, render_template, request, jsonify, session
from dotenv import load_dotenv
from werkzeug.security import check_password_hash
from werkzeug.utils import secure_filename
import requests

from cloud_sync import CloudSyncVault
from db_setup import (
    init_db, get_stored_password_hash, update_master_password,
    create_qr_session_db, get_qr_session_db, approve_qr_session_db,
    list_authenticated_qr_sessions_db, update_qr_restriction_field_db,
    terminate_qr_session_db, get_cloud_account_db, get_first_enabled_cloud_account_db,
    get_all_cloud_accounts_db, save_or_update_cloud_account_db,
    update_cloud_account_tokens_db, set_cloud_account_status_db,
    modify_cloud_account_db, save_imported_asset_db, get_all_imported_assets_db,
    get_print_queue_db, add_to_print_queue_db, remove_from_print_queue_db,
    record_sync_event_db, get_latest_sync_state_db
)

if not hasattr(requests.Response, 'status_ok'):
    requests.Response.status_ok = property(lambda self: self.ok)

os.environ['OAUTHLIB_INSECURE_TRANSPORT'] = '1'
load_dotenv()

DB_PATH = os.getenv('DATABASE_PATH', 'secure_vault.db')
DOCUMENTS_DIR = os.getenv("DOCUMENTS_DIR", os.path.join(os.getcwd(), 'documents'))
os.makedirs(DOCUMENTS_DIR, exist_ok=True)

app = Flask(__name__)
app.secret_key = os.getenv('FLASK_SECRET_KEY', 'secure_vault_super_secret_key')

app.config['SESSION_COOKIE_SECURE'] = False
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'

cloud_vault_engine = CloudSyncVault(DB_PATH)
init_db()

ALLOWED_EXTENSIONS = {'pdf', 'jpg', 'jpeg', 'png', 'webp', 'ipynb'}

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


# ========================================================================
# 🔄 CLOUD TOKEN LIFETIME AUTO-REFRESH ENGINE
# ========================================================================
def get_valid_account_token(account_id):
    acc = get_cloud_account_db(account_id)
    if not acc:
        return None

    provider = acc['provider']
    access_token = acc['access_token']
    refresh_token = acc['refresh_token']
    expires_at = acc['expires_at'] or 0
    now = time.time()

    if access_token and (expires_at - now > 300):
        set_cloud_account_status_db(account_id, 'valid')
        return access_token

    if not refresh_token:
        set_cloud_account_status_db(account_id, 'expired')
        return None

    try:
        if provider == 'google':
            payload = {
                'client_id': cloud_vault_engine.google_config['client_id'],
                'client_secret': cloud_vault_engine.google_config['client_secret'],
                'refresh_token': refresh_token,
                'grant_type': 'refresh_token'
            }
            r = requests.post('https://oauth2.googleapis.com/token', data=payload, timeout=15)
        elif provider == 'onedrive':
            payload = {
                'client_id': cloud_vault_engine.onedrive_config['client_id'],
                'client_secret': cloud_vault_engine.onedrive_config['client_secret'],
                'refresh_token': refresh_token,
                'grant_type': 'refresh_token'
            }
            r = requests.post('https://login.microsoftonline.com/common/oauth2/v2.0/token', data=payload, timeout=15)
        else:
            return access_token

        if r.ok:
            token_data = r.json()
            new_access = token_data.get('access_token')
            new_refresh = token_data.get('refresh_token') or refresh_token
            new_expiry = now + int(token_data.get('expires_in', 3600))
            update_cloud_account_tokens_db(account_id, new_access, new_refresh, new_expiry, 'valid')
            return new_access
        else:
            set_cloud_account_status_db(account_id, 'expired')
    except Exception as e:
        print(f"[TOKEN REFRESH ERROR]: {e}")

    return None


def fetch_files_from_provider_account(account_id, folder_id='root'):
    acc = get_cloud_account_db(account_id)
    if not acc:
        return None

    provider = acc['provider']
    display_label = acc['custom_name'] if acc['custom_name'] else acc['email']
    token = get_valid_account_token(account_id)
    if not token:
        return None

    headers = {'Authorization': f'Bearer {token}'}
    items = []

    try:
        if provider == 'google':
            q = f"'{folder_id}' in parents and trashed = false"
            params = {'q': q, 'fields': 'files(id, name, mimeType, size)', 'pageSize': 100}
            r = requests.get('https://www.googleapis.com/drive/v3/files', headers=headers, params=params, timeout=15)
            if not r.ok:
                return None
            for f in r.json().get('files', []):
                mime = f.get('mimeType', '')
                is_folder = mime == 'application/vnd.google-apps.folder'
                ext = f.get('name', '').rsplit('.', 1)[-1].lower() if '.' in f.get('name', '') else ''
                if is_folder or mime == 'application/pdf' or ext in ALLOWED_EXTENSIONS:
                    items.append({
                        'cloud_id': f['id'],
                        'name': f['name'],
                        'type': 'folder' if is_folder else 'file',
                        'file_type': 'folder' if is_folder else ('pdf' if (ext == 'pdf' or mime == 'application/pdf') else 'image'),
                        'size': int(f.get('size', 0)),
                        'provider': 'google',
                        'account_id': account_id,
                        'account_name': display_label
                    })

        elif provider == 'onedrive':
            url = (
                "https://graph.microsoft.com/v1.0/me/drive/root/children"
                if folder_id == 'root'
                else f"https://graph.microsoft.com/v1.0/me/drive/items/{folder_id}/children"
            )
            r = requests.get(url, headers=headers, timeout=15)
            if not r.ok:
                return None
            for f in r.json().get('value', []):
                is_folder = 'folder' in f
                name = f.get('name', '')
                ext = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
                if is_folder or ext in ALLOWED_EXTENSIONS:
                    items.append({
                        'cloud_id': f['id'],
                        'name': name,
                        'type': 'folder' if is_folder else 'file',
                        'file_type': 'folder' if is_folder else ('pdf' if ext == 'pdf' else 'image'),
                        'size': int(f.get('size', 0)),
                        'provider': 'onedrive',
                        'account_id': account_id,
                        'account_name': display_label
                    })
    except Exception as e:
        print(f"[CLOUD FETCH ERROR]: {e}")
        return None

    return sorted(items, key=lambda x: (x['type'] != 'folder', x['name'].lower()))


# ========================================================================
# 🎯 1. CORE PAGE & QR ROUTES
# ========================================================================
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/scan', methods=['GET'])
def my_private_scanner():
    return render_template('scanner.html')

@app.route('/generate-qr-session', methods=['GET'])
def generate_qr_session():
    ua = request.headers.get('User-Agent', 'Desktop Browser')
    device_label = "Windows PC" if "Windows" in ua else ("Mac" if "Mac" in ua else "Desktop")
    try:
        session_id = create_qr_session_db(device_label)
    except Exception:
        return jsonify({"error": "Database error"}), 500
    
    qr = qrcode.QRCode(version=1, box_size=10, border=4)
    qr.add_data(session_id)
    qr.make(fit=True)
    img = qr.make_image(fill_color="#0f172a", back_color="white")
    buffered = io.BytesIO()
    img.save(buffered, format="PNG")
    qr_base64 = base64.b64encode(buffered.getvalue()).decode('utf-8')
    
    return jsonify({
        "session_id": session_id,
        "qr_image": f"data:image/png;base64,{qr_base64}"
    })

@app.route('/verify-private-scan/<session_id>', methods=['GET', 'POST'])
def verify_private_scan(session_id):
    clean_sid = session_id.split('?')[0].strip()
    row = get_qr_session_db(clean_sid)
    if not row:
        return jsonify({"success": False, "error": "Invalid or Terminated Session!"}), 404

    if row['status'] == "pending" and (time.time() - row['created_at'] > 25):
        return jsonify({"success": False, "error": "QR Code Expired!"}), 404

    if request.method == 'POST':
        approve_qr_session_db(clean_sid)
        return jsonify({"success": True, "message": "Desktop Authenticated in Restricted Mode"}), 200

    if row['status'] == "authenticated":
        session.permanent = True
        session['is_authenticated'] = True
        session['session_id'] = clean_sid
        session['login_type'] = 'qr_restricted'
        latest_event, _ = get_latest_sync_state_db()
        resp = make_response(jsonify({
            "success": True,
            "status": "authenticated",
            "restrictions": {
                "is_restricted": bool(row['is_restricted']),
                "mask_folders": bool(row['mask_folders']),
                "disable_profile": bool(row['disable_profile']),
                "allow_print": bool(row['allow_print'])
            },
            "latest_event": latest_event
        }))
    elif row['status'] == "terminated":
        session.clear()
        resp = make_response(jsonify({"success": False, "status": "terminated"}))
    else:
        resp = make_response(jsonify({"success": False, "status": row['status']}))

    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
    return resp

@app.route('/api/connected-sessions', methods=['GET'])
def get_connected_sessions():
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized"}), 403
    sessions = list_authenticated_qr_sessions_db()
    return jsonify({"count": len(sessions), "sessions": sessions})

@app.route('/api/session-restrictions/update', methods=['POST'])
def update_session_restrictions():
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized"}), 403
    data = request.get_json(silent=True) or {}
    ok = update_qr_restriction_field_db(data.get('session_id'), data.get('field'), data.get('value'))
    if not ok:
        return jsonify({"success": False, "error": "Invalid field"}), 400
    return jsonify({"success": True})

@app.route('/terminate-desktop-session', methods=['POST'])
def terminate_desktop_session():
    data = request.get_json(silent=True) or {}
    sid = data.get('session_id', 'all')
    if sid != 'all' and sid:
        sid = sid.split('?')[0].strip()
    terminate_qr_session_db(sid)
    return jsonify({"success": True, "message": "Connected desktop session(s) logged out"}), 200


# ========================================================================
# 🎯 2. AUTHENTICATION & UNIVERSAL SYNC POLLING
# ========================================================================
@app.route('/api/check-session', methods=['GET'])
def check_session_status():
    sid = session.get('session_id')
    login_type = session.get('login_type', 'master')
    restrictions = {"is_restricted": False, "mask_folders": False, "disable_profile": False, "allow_print": True}

    if sid and login_type == 'qr_restricted':
        r = get_qr_session_db(sid)
        if not r or r['status'] != 'authenticated':
            session.clear()
            return jsonify({"authenticated": False}), 200
        restrictions = {
            "is_restricted": bool(r['is_restricted']),
            "mask_folders": bool(r['mask_folders']),
            "disable_profile": bool(r['disable_profile']),
            "allow_print": bool(r['allow_print'])
        }

    latest_ev, _ = get_latest_sync_state_db()
    return jsonify({
        "authenticated": bool(session.get('is_authenticated')),
        "session_id": sid,
        "login_type": login_type,
        "restrictions": restrictions,
        "latest_event_id": latest_ev["event_id"] if latest_ev else 0
    }), 200

@app.route('/api/poll-events', methods=['GET'])
def poll_vault_events():
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized"}), 403
    latest, active_count = get_latest_sync_state_db()
    return jsonify({"latest_event": latest, "connected_count": active_count})

@app.route('/api/login', methods=['POST'])
def api_login():
    data = request.get_json() or {}
    password = data.get('password')
    stored_hash = get_stored_password_hash()
    if password and stored_hash and check_password_hash(stored_hash, password):
        session.permanent = True
        session['is_authenticated'] = True
        session['session_id'] = "core_authenticated_user"
        session['login_type'] = "master"
        return jsonify({"success": True, "login_type": "master"})
    return jsonify({"success": False, "error": "Invalid credentials!"}), 401

@app.route('/change-password', methods=['POST'])
def change_password():
    if not session.get('is_authenticated') or session.get('login_type') == 'qr_restricted':
        return jsonify({"success": False, "message": "Unauthorized in Restricted Mode"}), 401
    data = request.json or {}
    stored_hash = get_stored_password_hash()
    if not stored_hash or not check_password_hash(stored_hash, data.get('current_password', '')):
        return jsonify({"success": False, "message": "Current password is incorrect"})
    success, message = update_master_password(data.get('new_password'))
    return jsonify({"success": success, "message": message})

@app.route('/api/logout', methods=['POST'])
def api_logout():
    sid = session.get('session_id')
    if sid and sid != "core_authenticated_user":
        terminate_qr_session_db(sid)
    session.clear()
    return jsonify({"success": True})


# ========================================================================
# 🖨️ 3. "TO BE PRINTED" WISHLIST QUEUE
# ========================================================================
@app.route('/api/print-queue', methods=['GET', 'POST', 'DELETE'])
def manage_print_queue():
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized"}), 403
    if request.method == 'GET':
        return jsonify({"items": get_print_queue_db()})
    data = request.get_json(silent=True) or {}
    if request.method == 'POST':
        add_to_print_queue_db(data)
        return jsonify({"success": True})
    if request.method == 'DELETE':
        remove_from_print_queue_db(data.get('item_path'))
        return jsonify({"success": True})


# ========================================================================
# 📤 4. UPLOAD FILE & BROADCAST INSTANT SYNC EVENT
# ========================================================================
@app.route('/api/upload-file', methods=['POST'])
def upload_file_to_vault():
    if not session.get('is_authenticated'):
        return jsonify({"success": False, "error": "Unauthorized Access!"}), 403
    if 'file' not in request.files:
        return jsonify({"success": False, "error": "No file selected"}), 400

    file = request.files['file']
    target_folder = request.form.get('folder_path', '').strip('/')

    if file.filename == '' or not allowed_file(file.filename):
        return jsonify({"success": False, "error": "Invalid file or file type!"}), 400

    filename = secure_filename(file.filename)
    destination_dir = os.path.normpath(os.path.join(DOCUMENTS_DIR, target_folder))
    if not destination_dir.startswith(os.path.normpath(DOCUMENTS_DIR)):
        return jsonify({"success": False, "error": "Invalid directory path!"}), 403

    try:
        os.makedirs(destination_dir, exist_ok=True)
        save_path = os.path.join(destination_dir, filename)
        file.save(save_path)

        ext = filename.rsplit('.', 1)[1].lower()
        file_type = "notebook" if ext == 'ipynb' else ("pdf" if ext == 'pdf' else "image")
        file_size = os.path.getsize(save_path)

        # Broadcast instant upload event to all connected desktops (Master or QR)
        record_sync_event_db('file_uploaded', filename, target_folder or 'Root Vault')

        return jsonify({
            "success": True,
            "file_item": {
                "name": filename,
                "type": "file",
                "file_type": file_type,
                "size": file_size,
                "provider": "local",
                "account_name": "Local Vault"
            }
        }), 200
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ========================================================================
# 📂 5. FETCH VAULT LIST & STREAM FILE DATA
# ========================================================================
@app.route('/fetch-vault-list', methods=['POST'])
def fetch_vault_list():
    data = request.get_json(silent=True) or {}
    session_id = data.get('session_id') or session.get('session_id')
    if session_id:
        session_id = session_id.split('?')[0].strip()

    is_session_valid = session.get('is_authenticated') == True
    if not is_session_valid and session_id:
        qr_row = get_qr_session_db(session_id)
        if qr_row and qr_row['status'] == "authenticated":
            is_session_valid = True
            session.permanent = True
            session['is_authenticated'] = True
            session['session_id'] = session_id
            session['login_type'] = 'qr_restricted'

    if not is_session_valid:
        return jsonify({"error": "Unauthorized Access!"}), 403

    def build_tree(current_dir):
        tree = []
        try:
            for entry in os.scandir(current_dir):
                ext = entry.name.split('.')[-1].lower() if '.' in entry.name else ''
                if entry.is_dir():
                    tree.append({
                        "name": entry.name,
                        "type": "folder",
                        "children": build_tree(entry.path),
                        "provider": "local",
                        "account_name": "Local Vault",
                        "is_expired": False
                    })
                elif entry.is_file() and ext in ALLOWED_EXTENSIONS:
                    file_type = "notebook" if ext == 'ipynb' else ("pdf" if ext == 'pdf' else "image")
                    tree.append({
                        "name": entry.name,
                        "type": "file",
                        "file_type": file_type,
                        "size": entry.stat().st_size,
                        "provider": "local",
                        "account_name": "Local Vault",
                        "is_expired": False
                    })
        except Exception:
            pass
        return sorted(tree, key=lambda x: (x['type'] != 'folder', x['name'].lower()))

    vault_tree = build_tree(DOCUMENTS_DIR)

    try:
        acc_map = {}
        for r in get_all_cloud_accounts_db():
            acc_id = r["account_id"]
            tok = get_valid_account_token(acc_id)
            acc_map[acc_id] = {
                "name": r["custom_name"] if r["custom_name"] else r["email"],
                "enabled": bool(r["is_enabled"]),
                "expired": (tok is None)
            }

        for row in get_all_imported_assets_db():
            acc_id = row["account_id"]
            if acc_id and acc_id in acc_map and not acc_map[acc_id]["enabled"]:
                continue
            is_expired = acc_map[acc_id]["expired"] if (acc_id and acc_id in acc_map) else False
            effective_acc_name = acc_map[acc_id]["name"] if (acc_id and acc_id in acc_map) else (row["account_name"] or "Cloud Drive")
            inner_children = []
            try:
                if row["children_data"] and not is_expired:
                    inner_children = json.loads(row["children_data"])
            except Exception:
                pass

            vault_tree.append({
                "name": row["name"],
                "type": row["type"],
                "file_type": "folder" if row["type"] == 'folder' else "pdf",
                "size": 0,
                "children": inner_children,
                "cloud_id": row["cloud_id"],
                "provider": row["provider"] or "google",
                "account_id": acc_id or "",
                "account_name": effective_acc_name,
                "is_expired": is_expired
            })
    except Exception as e:
        print(f"[MERGE WARNING]: {e}")

    return jsonify({"tree": vault_tree})


@app.route('/fetch-file-data', methods=['POST'])
def fetch_file_data():
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized Access!"}), 403

    data = request.get_json(silent=True) or {}
    relative_path = data.get('filename')
    cloud_id = data.get('cloud_id')
    account_id = data.get('account_id')

    if relative_path:
        secure_path = os.path.normpath(os.path.join(DOCUMENTS_DIR, relative_path.lstrip('/')))
        if secure_path.startswith(os.path.normpath(DOCUMENTS_DIR)) and os.path.exists(secure_path):
            with open(secure_path, "rb") as f:
                return jsonify({"base64": base64.b64encode(f.read()).decode('utf-8')})

    if cloud_id:
        acc = get_cloud_account_db(account_id) if account_id else get_first_enabled_cloud_account_db()
        if acc:
            token = get_valid_account_token(acc['account_id'])
            if token:
                headers = {'Authorization': f'Bearer {token}'}
                url = (
                    f"https://www.googleapis.com/drive/v3/files/{cloud_id}?alt=media"
                    if acc['provider'] == 'google'
                    else f"https://graph.microsoft.com/v1.0/me/drive/items/{cloud_id}/content"
                )
                r = requests.get(url, headers=headers, timeout=25)
                if r.ok:
                    if relative_path:
                        local_cache_path = os.path.normpath(os.path.join(DOCUMENTS_DIR, relative_path.lstrip('/')))
                        if local_cache_path.startswith(os.path.normpath(DOCUMENTS_DIR)):
                            os.makedirs(os.path.dirname(local_cache_path), exist_ok=True)
                            with open(local_cache_path, "wb") as f:
                                f.write(r.content)
                    return jsonify({"base64": base64.b64encode(r.content).decode('utf-8')}), 200

    return jsonify({"error": "File not found!"}), 404


# ========================================================================
# ☁️ 6. MULTI-ACCOUNT OAUTH & MANAGEMENT
# ========================================================================
def build_offline_oauth_url(provider, custom_name=""):
    state_payload = base64.urlsafe_b64encode(json.dumps({"custom_name": custom_name}).encode()).decode()
    if provider == 'google':
        params = {
            'client_id': cloud_vault_engine.google_config['client_id'],
            'redirect_uri': cloud_vault_engine.google_config['redirect_uri'],
            'response_type': 'code',
            'scope': 'https://www.googleapis.com/auth/drive.readonly email profile',
            'access_type': 'offline',
            'prompt': 'consent select_account',
            'state': state_payload
        }
        return f"https://accounts.google.com/o/oauth2/v2/auth?{urlencode(params)}"
    elif provider == 'onedrive':
        params = {
            'client_id': cloud_vault_engine.onedrive_config['client_id'],
            'redirect_uri': cloud_vault_engine.onedrive_config['redirect_uri'],
            'response_type': 'code',
            'scope': 'Files.Read.All User.Read offline_access',
            'prompt': 'select_account',
            'state': state_payload
        }
        return f"https://login.microsoftonline.com/common/oauth2/v2.0/authorize?{urlencode(params)}"
    return ""

@app.route('/api/cloud/oauth-url/<provider>', methods=['POST'])
def get_provider_oauth_url(provider):
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized"}), 403
    data = request.get_json(silent=True) or {}
    url = build_offline_oauth_url(provider, data.get('custom_name', '').strip())
    return jsonify({"auth_url": url})

@app.route('/api/google/callback')
def google_oauth_callback():
    session['is_authenticated'] = True
    auth_code = request.args.get('code')
    state_raw = request.args.get('state', '')
    if not auth_code:
        return "Authorization denied.", 400

    custom_name = ""
    try:
        if state_raw:
            custom_name = json.loads(base64.urlsafe_b64decode(state_raw.encode()).decode()).get("custom_name", "").strip()
    except Exception:
        pass

    payload = {
        'code': auth_code,
        'client_id': cloud_vault_engine.google_config['client_id'],
        'client_secret': cloud_vault_engine.google_config['client_secret'],
        'redirect_uri': cloud_vault_engine.google_config['redirect_uri'],
        'grant_type': 'authorization_code'
    }
    r = requests.post('https://oauth2.googleapis.com/token', data=payload, timeout=15)
    token_results = r.json()

    if 'access_token' in token_results:
        access_token = token_results['access_token']
        refresh_token = token_results.get('refresh_token', '')
        expires_at = time.time() + int(token_results.get('expires_in', 3600))
        email = "google.user@gmail.com"
        try:
            u_info = requests.get('https://www.googleapis.com/oauth2/v2/userinfo', headers={'Authorization': f'Bearer {access_token}'}, timeout=10).json()
            email = u_info.get('email') or email
        except Exception:
            pass

        save_or_update_cloud_account_db('google', email, custom_name, access_token, refresh_token, expires_at)
        return render_template('oauth_callback.html', provider='google')
    return "Token exchange failed", 400

@app.route('/api/onedrive/callback')
def onedrive_oauth_callback():
    session['is_authenticated'] = True
    auth_code = request.args.get('code')
    state_raw = request.args.get('state', '')
    if not auth_code:
        return "Authorization denied.", 400

    custom_name = ""
    try:
        if state_raw:
            custom_name = json.loads(base64.urlsafe_b64decode(state_raw.encode()).decode()).get("custom_name", "").strip()
    except Exception:
        pass

    payload = {
        'code': auth_code,
        'client_id': cloud_vault_engine.onedrive_config['client_id'],
        'client_secret': cloud_vault_engine.onedrive_config['client_secret'],
        'redirect_uri': cloud_vault_engine.onedrive_config['redirect_uri'],
        'grant_type': 'authorization_code'
    }
    r = requests.post('https://login.microsoftonline.com/common/oauth2/v2.0/token', data=payload, timeout=15)
    token_results = r.json()

    if 'access_token' in token_results:
        access_token = token_results['access_token']
        refresh_token = token_results.get('refresh_token', '')
        expires_at = time.time() + int(token_results.get('expires_in', 3600))
        email = "onedrive.user@outlook.com"
        try:
            u_info = requests.get('https://graph.microsoft.com/v1.0/me', headers={'Authorization': f'Bearer {access_token}'}, timeout=10).json()
            email = u_info.get('mail') or u_info.get('userPrincipalName') or email
        except Exception:
            pass

        save_or_update_cloud_account_db('onedrive', email, custom_name, access_token, refresh_token, expires_at)
        return render_template('oauth_callback.html', provider='onedrive')
    return "Token exchange failed", 400

@app.route('/api/cloud/accounts', methods=['GET'])
def list_cloud_accounts():
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized"}), 403
    accounts = []
    for row in get_all_cloud_accounts_db():
        acc_id = row["account_id"]
        tok = get_valid_account_token(acc_id)
        accounts.append({
            "account_id": acc_id,
            "provider": row["provider"],
            "custom_name": row["custom_name"] if row["custom_name"] else row["email"],
            "email": row["email"],
            "is_enabled": bool(row["is_enabled"]),
            "expires_at": row["expires_at"],
            "is_expired": (tok is None)
        })
    return jsonify({"accounts": accounts})

@app.route('/api/cloud/account/update', methods=['POST'])
def update_cloud_account():
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized"}), 403
    data = request.get_json(silent=True) or {}
    action = data.get('action')
    val = data.get('is_enabled') if action == 'toggle' else data.get('custom_name', '').strip()
    modify_cloud_account_db(data.get('account_id'), action, val)
    return jsonify({"success": True})

@app.route('/api/cloud/fetch/<account_id>', methods=['POST'])
def fetch_account_files(account_id):
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized"}), 403
    data = request.get_json(silent=True) or {}
    tree = fetch_files_from_provider_account(account_id, folder_id=data.get('folder_id', 'root'))
    if tree is None:
        return jsonify({"authenticated": False, "error": "Token expired"}), 200
    return jsonify({"authenticated": True, "tree": tree}), 200

@app.route('/api/cloud/import', methods=['POST'])
def import_cloud_asset():
    if not session.get('is_authenticated'):
        return jsonify({"success": False, "error": "Unauthorized"}), 403

    data = request.get_json(silent=True) or {}
    asset_name = data.get('name')
    cloud_id = data.get('cloud_id')
    asset_type = data.get('type') or "file"
    account_id = data.get('account_id') or ""
    provider = data.get('provider') or "google"
    account_name = data.get('account_name') or "Cloud Drive"

    if not asset_name or not cloud_id:
        return jsonify({"success": False, "error": "Missing parameters"}), 400

    children_tree = []
    if asset_type == 'folder' and account_id:
        children_tree = fetch_files_from_provider_account(account_id, folder_id=cloud_id) or []
        for child in children_tree:
            if child.get('type') == 'folder':
                sub_children = fetch_files_from_provider_account(account_id, folder_id=child.get('cloud_id'))
                child['children'] = sub_children if sub_children else []

    save_imported_asset_db(cloud_id, asset_name, asset_type, children_tree, provider, account_id, account_name)
    return jsonify({
        "success": True,
        "imported_item": {
            "name": asset_name,
            "type": asset_type,
            "file_type": "folder" if asset_type == 'folder' else "pdf",
            "size": 0,
            "children": children_tree,
            "cloud_id": cloud_id,
            "provider": provider,
            "account_id": account_id,
            "account_name": account_name,
            "is_expired": False
        }
    }), 200


if __name__ == '__main__':
    # app.run(host='0.0.0.0', debug=True, port=8080)
    app.run(host='0.0.0.0', port=8080, debug=True, threaded=True, ssl_context='adhoc')