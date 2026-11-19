import os
import time
import uuid
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlencode
import requests
from flask import Blueprint, request, jsonify, session
from cloud_sync import CloudSyncVault
from db_setup import (
    get_db_connection,
    get_cloud_account_db,
    get_all_cloud_accounts_db,
    get_feature_flags_map_db
)

cloud_bp = Blueprint('cloud', __name__)
cloud_engine = CloudSyncVault()

ALLOWED_EXTENSIONS = {'pdf', 'jpg', 'jpeg', 'png', 'webp', 'ipynb'}

# Fast in-memory TTL caches to eliminate redundant OAuth & directory network calls
_TOKEN_MEM_CACHE = {}          # account_id -> (access_token, expires_at)
_CLOUD_DIR_MEM_CACHE = {}      # (account_id, folder_id, max_depth) -> (timestamp, items)
_DIR_CACHE_TTL = 120.0         # 2 minutes fresh cache for instant folder browsing


def invalidate_cloud_dir_cache(account_id: str = None):
    """Clears cached cloud directory listings for an account (or all accounts)."""
    if not account_id:
        _CLOUD_DIR_MEM_CACHE.clear()
        return
    keys_to_del = [k for k in _CLOUD_DIR_MEM_CACHE if k[0] == account_id]
    for k in keys_to_del:
        _CLOUD_DIR_MEM_CACHE.pop(k, None)


# ========================================================================
# 🔄 AUTOMATIC OAUTH ACCESS TOKEN REFRESH HELPER (WITH MEMORY CACHE)
# ========================================================================
def get_valid_account_token(account_id: str):
    """Returns a valid OAuth access token using RAM cache first, refreshing via refresh_token only when needed."""
    if not account_id:
        return None

    cached = _TOKEN_MEM_CACHE.get(account_id)
    if cached and time.time() < (cached[1] - 60):
        return cached[0]

    conn = None
    try:
        conn = get_db_connection()
        acc = conn.execute("SELECT * FROM cloud_accounts WHERE account_id = ?", (account_id,)).fetchone()
        if not acc or not acc['is_enabled']:
            _TOKEN_MEM_CACHE.pop(account_id, None)
            return None

        if acc['access_token'] and acc['expires_at'] and time.time() < (float(acc['expires_at']) - 60):
            exp_ts = float(acc['expires_at'])
            _TOKEN_MEM_CACHE[account_id] = (acc['access_token'], exp_ts)
            return acc['access_token']

        refresh_token = acc['refresh_token']
        if not refresh_token:
            conn.execute("UPDATE cloud_accounts SET token_status = 'expired' WHERE account_id = ?", (account_id,))
            conn.commit()
            _TOKEN_MEM_CACHE.pop(account_id, None)
            return None

        provider = acc['provider']
        if provider == 'google':
            g_cfg = cloud_engine.google_config
            resp = requests.post(
                'https://oauth2.googleapis.com/token',
                data={
                    'client_id': g_cfg['client_id'],
                    'client_secret': g_cfg['client_secret'],
                    'refresh_token': refresh_token,
                    'grant_type': 'refresh_token'
                },
                timeout=10
            )
        else:
            o_cfg = cloud_engine.onedrive_config
            resp = requests.post(
                'https://login.microsoftonline.com/common/oauth2/v2.0/token',
                data={
                    'client_id': o_cfg['client_id'],
                    'client_secret': o_cfg['client_secret'],
                    'refresh_token': refresh_token,
                    'grant_type': 'refresh_token',
                    'scope': 'offline_access User.Read Files.ReadWrite.All'
                },
                timeout=10
            )

        if not resp.ok:
            conn.execute("UPDATE cloud_accounts SET token_status = 'expired' WHERE account_id = ?", (account_id,))
            conn.commit()
            _TOKEN_MEM_CACHE.pop(account_id, None)
            return None

        tok_data = resp.json()
        new_access = tok_data.get('access_token')
        new_refresh = tok_data.get('refresh_token', refresh_token)
        expires_in = int(tok_data.get('expires_in', 3500))
        new_exp = time.time() + expires_in

        conn.execute(
            """
            UPDATE cloud_accounts
            SET access_token = ?, refresh_token = ?, expires_at = ?, token_status = 'valid'
            WHERE account_id = ?
            """,
            (new_access, new_refresh, new_exp, account_id)
        )
        conn.commit()
        _TOKEN_MEM_CACHE[account_id] = (new_access, new_exp)
        return new_access

    except Exception as e:
        print(f"[CLOUD TOKEN REFRESH ERROR] ({account_id}): {e}")
        return None
    finally:
        if conn:
            conn.close()


# ========================================================================
# 🔄 AUTO-SYNC ALREADY MOUNTED CLOUD FOLDERS
# ========================================================================
def refresh_mounted_assets_for_account(account_id: str, provider: str, token: str, account_name: str):
    """Refreshes the folder tree of all mounted assets for a cloud account."""
    if not account_id or not token:
        return

    invalidate_cloud_dir_cache(account_id)
    conn = None
    try:
        conn = get_db_connection()
        rows = conn.execute(
            "SELECT cloud_id, name, type FROM imported_assets WHERE account_id = ? OR (provider = ? AND account_id = '')",
            (account_id, provider)
        ).fetchall()

        for row in rows:
            cid = row['cloud_id']
            if row['type'] == 'folder':
                fresh_children = _fetch_cloud_folder_children(provider, token, cid, account_id, account_name, depth=0, max_depth=8)
                conn.execute(
                    """
                    UPDATE imported_assets
                    SET children_data = ?, account_id = ?, account_name = ?
                    WHERE cloud_id = ?
                    """,
                    (json.dumps(fresh_children), account_id, account_name, cid)
                )
            else:
                conn.execute(
                    "UPDATE imported_assets SET account_id = ?, account_name = ? WHERE cloud_id = ?",
                    (account_id, account_name, cid)
                )
        conn.commit()
    except Exception as e:
        print(f"[AUTO-SYNC MOUNTED ASSETS WARNING] ({account_id}): {e}")
    finally:
        if conn:
            conn.close()


@cloud_bp.route('/api/cloud/sync-all', methods=['POST'])
def sync_all_mounted_cloud_assets():
    """Background sync endpoint: refreshes all enabled mounted cloud folders in parallel without blocking initial UI."""
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized"}), 403

    accounts = [dict(a) for a in get_all_cloud_accounts_db() if a['is_enabled']]
    assets = [dict(r) for r in get_db_connection().execute("SELECT * FROM imported_assets WHERE type = 'folder'").fetchall()]
    if not accounts or not assets:
        return jsonify({"success": True, "updated": 0})

    acc_lookup = {a['account_id']: a for a in accounts}

    def _sync_one(asset):
        acc_id = asset.get('account_id')
        acc = acc_lookup.get(acc_id)
        if not acc:
            return None
        tok = get_valid_account_token(acc_id)
        if not tok:
            return None
        label = acc['custom_name'] or acc['email'] or acc_id
        children = _fetch_cloud_folder_children(acc['provider'], tok, asset['cloud_id'], acc_id, label, depth=0, max_depth=8)
        return (asset['cloud_id'], label, json.dumps(children))

    updated_count = 0
    with ThreadPoolExecutor(max_workers=5) as pool:
        results = list(pool.map(_sync_one, assets))

    conn = get_db_connection()
    try:
        for item in results:
            if item:
                cid, label, children_json = item
                conn.execute(
                    "UPDATE imported_assets SET children_data = ?, account_name = ? WHERE cloud_id = ?",
                    (children_json, label, cid)
                )
                updated_count += 1
        conn.commit()
    finally:
        conn.close()

    return jsonify({"success": True, "updated": updated_count})


# ========================================================================
# ☁️ LIST, TOGGLE, RENAME & REMOVE CONNECTED CLOUD ACCOUNTS
# ========================================================================
@cloud_bp.route('/api/cloud/accounts', methods=['GET'])
def list_connected_cloud_accounts():
    """Returns all linked Google Drive and OneDrive accounts for the authenticated user."""
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized"}), 403

    owner_id = session.get('user_id', 'user')
    conn = None
    try:
        conn = get_db_connection()
        rows = conn.execute(
            """
            SELECT account_id, provider, custom_name, email, is_enabled, token_status, created_at
            FROM cloud_accounts
            WHERE owner_id = ? OR owner_id = 'admin' OR owner_id IS NULL
            ORDER BY created_at DESC
            """,
            (owner_id,)
        ).fetchall()

        accounts = []
        for r in rows:
            acc = dict(r)
            tok = get_valid_account_token(acc['account_id']) if acc['is_enabled'] else None
            acc['is_expired'] = bool(acc['is_enabled'] and tok is None)
            accounts.append(acc)

        return jsonify({"accounts": accounts})
    except sqlite3.Error as e:
        return jsonify({"error": f"Database error: {e}"}), 500
    finally:
        if conn:
            conn.close()


@cloud_bp.route('/api/cloud/account/update', methods=['POST'])
def update_cloud_account():
    """Handles enabling/disabling, renaming, or unlinking a cloud storage account."""
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized"}), 403

    data = request.get_json(silent=True) or {}
    account_id = (data.get('account_id') or '').strip()
    action = (data.get('action') or '').strip()

    if not account_id:
        return jsonify({"success": False, "error": "Account ID required"}), 400

    invalidate_cloud_dir_cache(account_id)
    conn = None
    try:
        conn = get_db_connection()
        if action == 'toggle':
            is_enabled = 1 if data.get('is_enabled') else 0
            conn.execute("UPDATE cloud_accounts SET is_enabled = ? WHERE account_id = ?", (is_enabled, account_id))
            if not is_enabled:
                _TOKEN_MEM_CACHE.pop(account_id, None)
        elif action == 'rename':
            custom_name = (data.get('custom_name') or '').strip()
            acc_row = conn.execute(
                "SELECT email, account_id FROM cloud_accounts WHERE account_id = ?",
                (account_id,)
            ).fetchone()
            fallback_label = (acc_row['email'] or acc_row['account_id']) if acc_row else account_id
            effective_asset_name = custom_name if custom_name else fallback_label

            conn.execute("UPDATE cloud_accounts SET custom_name = ? WHERE account_id = ?", (custom_name, account_id))
            conn.execute("UPDATE imported_assets SET account_name = ? WHERE account_id = ?", (effective_asset_name, account_id))
        elif action == 'delete':
            _TOKEN_MEM_CACHE.pop(account_id, None)
            conn.execute("DELETE FROM cloud_accounts WHERE account_id = ?", (account_id,))
            conn.execute("DELETE FROM imported_assets WHERE account_id = ?", (account_id,))
            conn.execute("DELETE FROM print_queue WHERE account_id = ?", (account_id,))
        else:
            return jsonify({"success": False, "error": "Invalid action"}), 400

        conn.commit()
        return jsonify({"success": True})
    except sqlite3.Error as e:
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        if conn:
            conn.close()


# ========================================================================
# 🔐 DYNAMIC OAUTH 2.0 URL BUILDER & CALLBACK HANDLERS (ZERO MISMATCH)
# ========================================================================
@cloud_bp.route('/api/cloud/oauth-url/<provider>', methods=['POST'])
def generate_cloud_oauth_url(provider):
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized"}), 403

    flags = get_feature_flags_map_db()
    if not flags.get("cloud_drive_mount", True):
        return jsonify({"error": "Cloud Drive Mounting is currently disabled by Admin."}), 403

    data = request.get_json(silent=True) or {}
    custom_name = (data.get('custom_name') or '').strip()
    session['pending_cloud_custom_name'] = custom_name

    base_host = request.host_url.rstrip('/')

    if provider == 'google':
        g_cfg = cloud_engine.google_config
        if not g_cfg['client_id']:
            return jsonify({"error": "Google Client ID not configured in /admin console."}), 400

        dynamic_redirect = f"{base_host}/api/google/callback"
        session['active_google_redirect_uri'] = dynamic_redirect

        params = {
            'client_id': g_cfg['client_id'],
            'redirect_uri': dynamic_redirect,
            'response_type': 'code',
            'scope': 'openid email profile https://www.googleapis.com/auth/drive',
            'access_type': 'offline',
            'prompt': 'consent select_account'
        }
        return jsonify({"auth_url": f"https://accounts.google.com/o/oauth2/v2/auth?{urlencode(params)}"})

    elif provider == 'onedrive':
        o_cfg = cloud_engine.onedrive_config
        if not o_cfg['client_id']:
            return jsonify({"error": "OneDrive Client ID not configured in /admin console."}), 400

        dynamic_redirect = f"{base_host}/api/onedrive/callback"
        session['active_onedrive_redirect_uri'] = dynamic_redirect

        params = {
            'client_id': o_cfg['client_id'],
            'redirect_uri': dynamic_redirect,
            'response_type': 'code',
            'scope': 'offline_access User.Read Files.ReadWrite.All',
            'prompt': 'select_account'
        }
        return jsonify({"auth_url": f"https://login.microsoftonline.com/common/oauth2/v2.0/authorize?{urlencode(params)}"})

    return jsonify({"error": "Unsupported cloud provider"}), 400


@cloud_bp.route('/api/google/callback')
def google_cloud_oauth_callback():
    code = request.args.get('code')
    if not code:
        return "<script>window.close();</script>", 400

    g_cfg = cloud_engine.google_config
    redirect_uri = session.get('active_google_redirect_uri') or f"{request.host_url.rstrip('/')}/api/google/callback"
    custom_name = (session.pop('pending_cloud_custom_name', '') or '').strip()
    owner_id = session.get('user_id', 'user')

    conn = None
    try:
        tok_resp = requests.post(
            'https://oauth2.googleapis.com/token',
            data={
                'code': code,
                'client_id': g_cfg['client_id'],
                'client_secret': g_cfg['client_secret'],
                'redirect_uri': redirect_uri,
                'grant_type': 'authorization_code'
            },
            timeout=15
        )
        tok_data = tok_resp.json()
        access_token = tok_data.get('access_token')
        refresh_token = tok_data.get('refresh_token', '')
        expires_in = int(tok_data.get('expires_in', 3500))

        if not access_token:
            err_msg = tok_data.get('error_description') or tok_data.get('error') or 'Token exchange failed'
            return f"<h3>Google OAuth Error: {err_msg}</h3>", 400

        profile = requests.get(
            'https://www.googleapis.com/oauth2/v2/userinfo',
            headers={'Authorization': f'Bearer {access_token}'},
            timeout=10
        ).json()
        email = (profile.get('email') or 'google_user@gmail.com').lower()
        effective_label = custom_name if custom_name else email
        exp_ts = time.time() + expires_in

        conn = get_db_connection()
        existing = conn.execute(
            "SELECT account_id, refresh_token FROM cloud_accounts WHERE provider = 'google' AND email = ?",
            (email,)
        ).fetchone()

        if existing:
            acc_id = existing['account_id']
            final_refresh = refresh_token or existing['refresh_token']
            conn.execute(
                """
                UPDATE cloud_accounts
                SET owner_id = ?, custom_name = ?, access_token = ?, refresh_token = ?, expires_at = ?, is_enabled = 1, token_status = 'valid'
                WHERE account_id = ?
                """,
                (owner_id, custom_name, access_token, final_refresh, exp_ts, acc_id)
            )
        else:
            acc_id = f"gdrv_{uuid.uuid4().hex[:8]}"
            conn.execute(
                """
                INSERT INTO cloud_accounts
                (account_id, owner_id, provider, custom_name, email, access_token, refresh_token, expires_at, is_enabled, token_status)
                VALUES (?, ?, 'google', ?, ?, ?, ?, ?, 1, 'valid')
                """,
                (acc_id, owner_id, custom_name, email, access_token, refresh_token, exp_ts)
            )
        conn.commit()
        _TOKEN_MEM_CACHE[acc_id] = (access_token, exp_ts)
        refresh_mounted_assets_for_account(acc_id, 'google', access_token, effective_label)

        return """
        <script>
          if (window.opener) {
            window.opener.postMessage({ status: "success", provider: "google" }, "*");
          }
          window.close();
        </script>
        """
    except Exception as e:
        print(f"[GOOGLE CLOUD CALLBACK ERROR]: {e}")
        return f"<h3>Google Drive Connection Failed: {e}</h3>", 500
    finally:
        if conn:
            conn.close()


@cloud_bp.route('/api/onedrive/callback')
def onedrive_cloud_oauth_callback():
    code = request.args.get('code')
    if not code:
        return "<script>window.close();</script>", 400

    o_cfg = cloud_engine.onedrive_config
    redirect_uri = session.get('active_onedrive_redirect_uri') or f"{request.host_url.rstrip('/')}/api/onedrive/callback"
    custom_name = (session.pop('pending_cloud_custom_name', '') or '').strip()
    owner_id = session.get('user_id', 'user')

    conn = None
    try:
        tok_resp = requests.post(
            'https://login.microsoftonline.com/common/oauth2/v2.0/token',
            data={
                'client_id': o_cfg['client_id'],
                'client_secret': o_cfg['client_secret'],
                'code': code,
                'redirect_uri': redirect_uri,
                'grant_type': 'authorization_code',
                'scope': 'offline_access User.Read Files.ReadWrite.All'
            },
            timeout=15
        )
        tok_data = tok_resp.json()
        access_token = tok_data.get('access_token')
        refresh_token = tok_data.get('refresh_token', '')
        expires_in = int(tok_data.get('expires_in', 3500))

        if not access_token:
            err_msg = tok_data.get('error_description') or tok_data.get('error') or 'Token exchange failed'
            return f"<h3>OneDrive OAuth Error: {err_msg}</h3>", 400

        me = requests.get(
            'https://graph.microsoft.com/v1.0/me',
            headers={'Authorization': f'Bearer {access_token}'},
            timeout=10
        ).json()
        email = (me.get('mail') or me.get('userPrincipalName') or 'onedrive_user@outlook.com').lower()
        effective_label = custom_name if custom_name else email
        exp_ts = time.time() + expires_in

        conn = get_db_connection()
        existing = conn.execute(
            "SELECT account_id, refresh_token FROM cloud_accounts WHERE provider = 'onedrive' AND email = ?",
            (email,)
        ).fetchone()

        if existing:
            acc_id = existing['account_id']
            final_refresh = refresh_token or existing['refresh_token']
            conn.execute(
                """
                UPDATE cloud_accounts
                SET owner_id = ?, custom_name = ?, access_token = ?, refresh_token = ?, expires_at = ?, is_enabled = 1, token_status = 'valid'
                WHERE account_id = ?
                """,
                (owner_id, custom_name, access_token, final_refresh, exp_ts, acc_id)
            )
        else:
            acc_id = f"odrv_{uuid.uuid4().hex[:8]}"
            conn.execute(
                """
                INSERT INTO cloud_accounts
                (account_id, owner_id, provider, custom_name, email, access_token, refresh_token, expires_at, is_enabled, token_status)
                VALUES (?, ?, 'onedrive', ?, ?, ?, ?, ?, 1, 'valid')
                """,
                (acc_id, owner_id, custom_name, email, access_token, refresh_token, exp_ts)
            )
        conn.commit()
        _TOKEN_MEM_CACHE[acc_id] = (access_token, exp_ts)
        refresh_mounted_assets_for_account(acc_id, 'onedrive', access_token, effective_label)

        return """
        <script>
          if (window.opener) {
            window.opener.postMessage({ status: "success", provider: "onedrive" }, "*");
          }
          window.close();
        </script>
        """
    except Exception as e:
        print(f"[ONEDRIVE CLOUD CALLBACK ERROR]: {e}")
        return f"<h3>OneDrive Connection Failed: {e}</h3>", 500
    finally:
        if conn:
            conn.close()


# ========================================================================
# 📂 PARALLEL CLOUD FOLDER SCANNER & CACHED BROWSE PICKER
# ========================================================================
def _fetch_cloud_folder_children(
    provider: str,
    token: str,
    folder_id: str,
    account_id: str,
    account_name: str,
    depth: int = 0,
    max_depth: int = 8,
    visited: set = None
):
    """Fetches folders and supported files with parallel sub-folder traversal for high speed."""
    if depth > max_depth:
        return []
    if visited is None:
        visited = set()
    if folder_id in visited:
        return []
    visited.add(folder_id)

    headers = {'Authorization': f'Bearer {token}'}
    items = []
    subfolders = []

    try:
        if provider == 'google':
            query = f"'{folder_id}' in parents and trashed = false"
            resp = requests.get(
                'https://www.googleapis.com/drive/v3/files',
                headers=headers,
                params={
                    'q': query,
                    'fields': 'files(id, name, mimeType, size)',
                    'pageSize': 250
                },
                timeout=10
            )
            if not resp.ok:
                return []

            for f in resp.json().get('files', []):
                name = f.get('name', '')
                mime = f.get('mimeType', '')
                cid = f.get('id')
                is_folder = mime == 'application/vnd.google-apps.folder'
                ext = name.rsplit('.', 1)[-1].lower() if '.' in name else ''

                if is_folder:
                    folder_node = {
                        'name': name,
                        'type': 'folder',
                        'file_type': 'folder',
                        'cloud_id': cid,
                        'account_id': account_id,
                        'account_name': account_name,
                        'provider': 'google',
                        'children': []
                    }
                    items.append(folder_node)
                    if depth < max_depth:
                        subfolders.append(folder_node)
                elif ext in ALLOWED_EXTENSIONS:
                    items.append({
                        'name': name,
                        'type': 'file',
                        'file_type': 'notebook' if ext == 'ipynb' else ('pdf' if ext == 'pdf' else 'image'),
                        'size': int(f.get('size', 0)),
                        'cloud_id': cid,
                        'account_id': account_id,
                        'account_name': account_name,
                        'provider': 'google'
                    })
        else:
            url = (
                'https://graph.microsoft.com/v1.0/me/drive/root/children'
                if folder_id == 'root'
                else f'https://graph.microsoft.com/v1.0/me/drive/items/{folder_id}/children'
            )
            resp = requests.get(url, headers=headers, timeout=10)
            if not resp.ok:
                return []

            for f in resp.json().get('value', []):
                name = f.get('name', '')
                cid = f.get('id')
                is_folder = 'folder' in f
                ext = name.rsplit('.', 1)[-1].lower() if '.' in name else ''

                if is_folder:
                    folder_node = {
                        'name': name,
                        'type': 'folder',
                        'file_type': 'folder',
                        'cloud_id': cid,
                        'account_id': account_id,
                        'account_name': account_name,
                        'provider': 'onedrive',
                        'children': []
                    }
                    items.append(folder_node)
                    if depth < max_depth:
                        subfolders.append(folder_node)
                elif ext in ALLOWED_EXTENSIONS:
                    items.append({
                        'name': name,
                        'type': 'file',
                        'file_type': 'notebook' if ext == 'ipynb' else ('pdf' if ext == 'pdf' else 'image'),
                        'size': int(f.get('size', 0)),
                        'cloud_id': cid,
                        'account_id': account_id,
                        'account_name': account_name,
                        'provider': 'onedrive'
                    })

        # Fetch all child subfolders concurrently instead of one-by-one
        if subfolders:
            def _load_sub(node):
                node['children'] = _fetch_cloud_folder_children(
                    provider, token, node['cloud_id'], account_id, account_name,
                    depth=depth + 1, max_depth=max_depth, visited=set(visited)
                )

            with ThreadPoolExecutor(max_workers=min(6, len(subfolders))) as pool:
                list(pool.map(_load_sub, subfolders))

    except Exception as e:
        print(f"[CLOUD FOLDER SCAN WARNING] ({provider}/{folder_id}): {e}")

    return sorted(items, key=lambda x: (x['type'] != 'folder', x['name'].lower()))


@cloud_bp.route('/api/cloud/fetch/<account_id>', methods=['POST'])
def browse_cloud_account_root(account_id):
    """Fetches immediate children of a cloud folder with 2-minute RAM caching for instant browsing."""
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized"}), 403

    acc = get_cloud_account_db(account_id)
    if not acc:
        return jsonify({"authenticated": False, "error": "Account not found"}), 404

    data = request.get_json(silent=True) or {}
    folder_id = data.get('folder_id') or 'root'
    force_refresh = bool(data.get('force_refresh'))
    cache_key = (account_id, folder_id, 0)

    tree = None
    now = time.time()
    if not force_refresh and cache_key in _CLOUD_DIR_MEM_CACHE:
        ts, cached_items = _CLOUD_DIR_MEM_CACHE[cache_key]
        if (now - ts) < _DIR_CACHE_TTL:
            tree = [dict(i) for i in cached_items]

    if tree is None:
        token = get_valid_account_token(account_id)
        if not token:
            return jsonify({"authenticated": False, "error": "Token expired. Please reconnect."}), 401
        label = acc['custom_name'] or acc['email'] or acc['account_id']
        # max_depth=0 fetches ONLY current folder's direct children in 1 single API call (<250ms)
        tree = _fetch_cloud_folder_children(acc['provider'], token, folder_id, account_id, label, depth=0, max_depth=0)
        _CLOUD_DIR_MEM_CACHE[cache_key] = (now, [dict(i) for i in tree])

    mounted_ids = set()
    mounted_names = set()
    conn = None
    try:
        conn = get_db_connection()
        for r in conn.execute("SELECT cloud_id, name FROM imported_assets WHERE provider = ?", (acc['provider'],)).fetchall():
            if r['cloud_id']:
                mounted_ids.add(r['cloud_id'])
            if r['name']:
                mounted_names.add(r['name'])
    except sqlite3.Error:
        pass
    finally:
        if conn:
            conn.close()

    for item in tree:
        item['is_mounted'] = (item['cloud_id'] in mounted_ids) or (item['name'] in mounted_names)

    return jsonify({"authenticated": True, "tree": tree})


@cloud_bp.route('/api/cloud/import', methods=['POST'])
def mount_cloud_asset_to_vault():
    """Mounts a selected Google Drive or OneDrive folder/file into the user's PrintSafe Vault."""
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized"}), 403

    data = request.get_json(silent=True) or {}
    name = (data.get('name') or '').strip()
    cloud_id = (data.get('cloud_id') or '').strip()
    asset_type = (data.get('type') or 'file').strip()
    account_id = (data.get('account_id') or '').strip()
    provider = (data.get('provider') or 'google').strip()
    account_name = (data.get('account_name') or 'Cloud Drive').strip()
    owner_id = session.get('user_id', 'user')

    if not cloud_id or not name:
        return jsonify({"success": False, "error": "Cloud asset ID and name are required"}), 400

    token = get_valid_account_token(account_id)
    if not token:
        return jsonify({"success": False, "error": "Cloud token expired"}), 401

    children = []
    if asset_type == 'folder':
        children = _fetch_cloud_folder_children(provider, token, cloud_id, account_id, account_name, depth=0, max_depth=8)

    conn = None
    try:
        conn = get_db_connection()
        conn.execute(
            """
            INSERT OR REPLACE INTO imported_assets
            (cloud_id, owner_id, name, type, children_data, session_id, provider, account_id, account_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (cloud_id, owner_id, name, asset_type, json.dumps(children), session.get('session_id', ''), provider, account_id, account_name)
        )
        conn.commit()
        return jsonify({
            "success": True,
            "imported_item": {
                "name": name,
                "cloud_id": cloud_id,
                "type": asset_type,
                "children": children
            }
        })
    except sqlite3.Error as e:
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        if conn:
            conn.close()


@cloud_bp.route('/api/cloud/unmount', methods=['POST'])
def unmount_cloud_asset_from_vault():
    """Unmounts an already mounted Google Drive or OneDrive folder/file from PrintSafe Vault."""
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized"}), 403

    data = request.get_json(silent=True) or {}
    cloud_id = (data.get('cloud_id') or '').strip()
    name = (data.get('name') or '').strip()

    conn = None
    try:
        conn = get_db_connection()
        if cloud_id:
            conn.execute("DELETE FROM imported_assets WHERE cloud_id = ?", (cloud_id,))
            conn.execute("DELETE FROM print_queue WHERE cloud_id = ?", (cloud_id,))
        if name:
            conn.execute("DELETE FROM imported_assets WHERE name = ?", (name,))
        conn.commit()
        return jsonify({"success": True, "message": f'"{name or "Item"}" unmounted from Vault!'})
    except sqlite3.Error as e:
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        if conn:
            conn.close()