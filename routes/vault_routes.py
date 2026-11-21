import os
import shutil
import base64
import json
import uuid
import time
import sqlite3
import requests
from flask import Blueprint, request, jsonify, session
from werkzeug.utils import secure_filename
from vault_crypto import encrypt_bytes, decrypt_bytes
from remote_storage import (
    encrypt_storage_password,
    decrypt_storage_password,
    test_remote_storage_connection,
    list_remote_directory,
    upload_remote_file_bytes,
    download_remote_file_bytes,
    delete_remote_file
)
from db_setup import (
    get_db_connection,
    get_qr_session_db, get_cloud_account_db, get_first_enabled_cloud_account_db,
    get_all_cloud_accounts_db, get_all_imported_assets_db,
    get_print_queue_db, add_to_print_queue_db, remove_from_print_queue_db,
    record_sync_event_db
)

vault_bp = Blueprint('vault', __name__)
DOCUMENTS_DIR = os.getenv("DOCUMENTS_DIR", os.path.join(os.getcwd(), 'documents'))
os.makedirs(DOCUMENTS_DIR, exist_ok=True)
ALLOWED_EXTENSIONS = {'pdf', 'jpg', 'jpeg', 'png', 'webp', 'ipynb'}


def allowed_file(filename):
    """Checks whether the uploaded filename has an allowed document/image extension."""
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def _resolve_cloud_upload_target(cloud_folder_id: str, account_id: str, provider: str, target_folder: str):
    """Resolves missing account_id/provider/cloud_folder_id from imported_assets & cloud_accounts DB."""
    conn = None
    try:
        conn = get_db_connection()
        # 1. If account_id is provided, verify & infer provider
        if account_id:
            acc = conn.execute(
                "SELECT account_id, provider FROM cloud_accounts WHERE account_id = ? AND is_enabled = 1",
                (account_id,)
            ).fetchone()
            if acc:
                provider = provider or (acc['provider'] or 'google').lower()
                cloud_folder_id = cloud_folder_id or 'root'
                return cloud_folder_id, account_id, provider

        # 2. Match top-level mounted folder name from target_folder (e.g., "Documents/Subfolder" -> "Documents")
        root_name = (target_folder.split('/')[0] if target_folder else '').strip()
        if root_name:
            asset = conn.execute(
                "SELECT cloud_id, account_id, provider FROM imported_assets WHERE name = ? LIMIT 1",
                (root_name,)
            ).fetchone()
            if asset:
                acc_id = asset['account_id']
                prov = (asset['provider'] or provider or 'google').lower()
                if not acc_id:
                    acc_row = conn.execute(
                        "SELECT account_id FROM cloud_accounts WHERE provider = ? AND is_enabled = 1 LIMIT 1",
                        (prov,)
                    ).fetchone()
                    acc_id = acc_row['account_id'] if acc_row else ''
                if acc_id:
                    return (cloud_folder_id or asset['cloud_id'] or 'root'), acc_id, prov

        # 3. Fallback to first enabled cloud account (matching provider if given)
        if provider in ('google', 'onedrive'):
            acc_row = conn.execute(
                "SELECT account_id, provider FROM cloud_accounts WHERE provider = ? AND is_enabled = 1 LIMIT 1",
                (provider,)
            ).fetchone()
        else:
            acc_row = conn.execute(
                "SELECT account_id, provider FROM cloud_accounts WHERE is_enabled = 1 LIMIT 1"
            ).fetchone()

        if acc_row:
            return (cloud_folder_id or 'root'), acc_row['account_id'], (acc_row['provider'] or 'google').lower()
    except Exception as e:
        print(f"[CLOUD TARGET RESOLVE WARNING]: {e}")
    finally:
        if conn:
            conn.close()

    return cloud_folder_id, account_id, provider

def _append_item_to_imported_assets_db(account_id: str, provider: str, target_folder: str, new_item: dict):
    """Persists newly uploaded files or created folders directly inside imported_assets.children_data in SQLite."""
    if not new_item or not provider:
        return
    conn = None
    try:
        conn = get_db_connection()
        if account_id:
            rows = conn.execute(
                "SELECT cloud_id, name, children_data FROM imported_assets WHERE type = 'folder' AND account_id = ?",
                (account_id,)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT cloud_id, name, children_data FROM imported_assets WHERE type = 'folder' AND provider = ?",
                (provider,)
            ).fetchall()

        segments = [s.strip() for s in (target_folder or '').split('/') if s.strip()]
        for row in rows:
            root_name = row['name']
            if segments and segments[0] != root_name:
                continue

            children = []
            try:
                if row['children_data']:
                    children = json.loads(row['children_data'])
            except Exception:
                children = []

            # Walk nested subfolders if target_folder has sub-paths (e.g., "Documents/SubFolder")
            target_list = children
            matched_path = True
            for seg in segments[1:]:
                found = next((c for c in target_list if c.get('type') == 'folder' and c.get('name') == seg), None)
                if found is not None:
                    if 'children' not in found or not isinstance(found['children'], list):
                        found['children'] = []
                    target_list = found['children']
                else:
                    matched_path = False
                    break

            if not matched_path:
                continue

            # Replace if same name & type already exists, else append
            idx = next(
                (i for i, c in enumerate(target_list) if c.get('name') == new_item.get('name') and c.get('type') == new_item.get('type')),
                -1
            )
            if idx != -1:
                target_list[idx] = new_item
            else:
                target_list.append(new_item)

            conn.execute(
                "UPDATE imported_assets SET children_data = ? WHERE cloud_id = ?",
                (json.dumps(children), row['cloud_id'])
            )
        conn.commit()
    except Exception as e:
        print(f"[IMPORTED ASSETS TREE PERSIST WARNING]: {e}")
    finally:
        if conn:
            conn.close()


# ========================================================================
# 🌐 CUSTOM HOSTING STORAGE (SSH/SFTP & FTP) — ADD, EDIT & HARD DELETE
# ========================================================================
@vault_bp.route('/api/remote-storage', methods=['GET', 'POST', 'PUT', 'DELETE'])
def manage_remote_storage():
    """Manages SFTP/FTP connections in SQLite and purges orphaned entries on delete."""
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized"}), 403

    owner_id = session.get('user_id', 'user')
    conn = None
    try:
        conn = get_db_connection()

        if request.method == 'GET':
            rows = conn.execute(
                """
                SELECT storage_id, label, protocol, host, port, username, base_path, is_enabled
                FROM remote_storages
                WHERE owner_id = ? OR owner_id = 'user' OR owner_id IS NULL
                ORDER BY created_at DESC
                """,
                (owner_id,)
            ).fetchall()
            return jsonify({"storages": [dict(r) for r in rows]})

        data = request.get_json(silent=True) or {}

        if request.method == 'POST':
            protocol = (data.get('protocol') or 'sftp').lower()
            host = (data.get('host') or '').strip()
            port = int(data.get('port') or (22 if protocol == 'sftp' else 21))
            username = (data.get('username') or '').strip()
            password = data.get('password') or ''
            base_path = (data.get('base_path') or '/').strip() or '/'
            label = (data.get('label') or f"{protocol.upper()} ({host})").strip()

            if not host or not username or not password:
                return jsonify({"success": False, "error": "Host, Username, and Password are required"}), 400

            dup = conn.execute(
                """
                SELECT storage_id FROM remote_storages
                WHERE (owner_id = ? OR owner_id = 'user')
                  AND protocol = ? AND host = ? AND port = ? AND username = ? AND base_path = ?
                """,
                (owner_id, protocol, host, port, username, base_path)
            ).fetchone()
            if dup:
                return jsonify({
                    "success": False,
                    "error": "This SFTP/FTP account is already connected! Click the Edit icon to update it."
                }), 409

            ok, msg = test_remote_storage_connection(protocol, host, port, username, password, base_path)
            if not ok:
                return jsonify({"success": False, "error": msg}), 400

            sid = f"rem_{uuid.uuid4().hex[:8]}"
            conn.execute('''
                INSERT INTO remote_storages
                (storage_id, owner_id, label, protocol, host, port, username, encrypted_secret, base_path, is_enabled, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
            ''', (sid, owner_id, label, protocol, host, port, username, encrypt_storage_password(password), base_path, time.time()))
            conn.commit()
            record_sync_event_db('storage_mounted', label, f"{protocol.upper()} • {host}")
            return jsonify({"success": True, "message": msg})

        if request.method == 'PUT':
            sid = data.get('storage_id')
            existing = conn.execute("SELECT * FROM remote_storages WHERE storage_id = ?", (sid,)).fetchone()
            if not existing:
                return jsonify({"success": False, "error": "Storage record not found"}), 404

            protocol = (data.get('protocol') or existing['protocol']).lower()
            host = (data.get('host') or existing['host']).strip()
            port = int(data.get('port') or existing['port'])
            username = (data.get('username') or existing['username']).strip()
            base_path = (data.get('base_path') or existing['base_path']).strip() or '/'
            label = (data.get('label') or existing['label']).strip()
            new_password = data.get('password') or ''

            if new_password:
                ok, msg = test_remote_storage_connection(protocol, host, port, username, new_password, base_path)
                if not ok:
                    return jsonify({"success": False, "error": msg}), 400
                enc_secret = encrypt_storage_password(new_password)
            else:
                enc_secret = existing['encrypted_secret']

            conn.execute('''
                UPDATE remote_storages
                SET owner_id = ?, label = ?, protocol = ?, host = ?, port = ?, username = ?, encrypted_secret = ?, base_path = ?
                WHERE storage_id = ?
            ''', (owner_id, label, protocol, host, port, username, enc_secret, base_path, sid))
            conn.commit()
            record_sync_event_db('storage_updated', label, f"{protocol.upper()} • {host}")
            return jsonify({"success": True, "message": "Hosting storage updated!", "new_label": label})

        if request.method == 'DELETE':
            sid = (data.get('storage_id') or '').strip()
            deleted_label = "Hosting Storage"
            if sid == 'all':
                conn.execute("DELETE FROM remote_storages WHERE owner_id = ? OR owner_id = 'user' OR owner_id IS NULL", (owner_id,))
                conn.execute("DELETE FROM print_queue WHERE provider IN ('ftp', 'sftp')")
            elif sid:
                row = conn.execute("SELECT label FROM remote_storages WHERE storage_id = ?", (sid,)).fetchone()
                conn.execute("DELETE FROM remote_storages WHERE storage_id = ?", (sid,))
                if row and row['label']:
                    deleted_label = row['label']
                    conn.execute("DELETE FROM print_queue WHERE account_name = ?", (row['label'],))
            conn.commit()
            record_sync_event_db('storage_unmounted', deleted_label, 'Hosting Storage')
            return jsonify({"success": True, "message": "Hosting storage permanently deleted!"})

    except sqlite3.Error as e:
        print(f"[REMOTE STORAGE DB ERROR]: {e}")
        return jsonify({"success": False, "error": f"Database error: {e}"}), 500
    finally:
        if conn:
            conn.close()


# ========================================================================
# 🗑️ UNMOUNT MOUNTED FOLDER & UNIVERSAL PERMANENT FILE DELETION
# ========================================================================
@vault_bp.route('/api/vault/remove-mounted', methods=['POST'])
def remove_mounted_asset():
    """Unmounts a mounted Cloud/Hosting root asset from the user's workspace view."""
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized"}), 403
    data = request.get_json(silent=True) or {}
    name = (data.get('name') or '').strip()
    cloud_id = (data.get('cloud_id') or '').strip()
    storage_id = (data.get('storage_id') or '').strip()

    conn = None
    try:
        conn = get_db_connection()
        if storage_id:
            conn.execute("DELETE FROM remote_storages WHERE storage_id = ?", (storage_id,))
        if cloud_id:
            conn.execute("DELETE FROM imported_assets WHERE cloud_id = ?", (cloud_id,))
        if name:
            conn.execute("DELETE FROM imported_assets WHERE name = ?", (name,))
            conn.execute("DELETE FROM remote_storages WHERE label = ?", (name,))
            conn.execute("DELETE FROM print_queue WHERE account_name = ? OR name = ?", (name, name))
        conn.commit()

        for root, dirs, _ in os.walk(DOCUMENTS_DIR):
            if name in dirs:
                shutil.rmtree(os.path.join(root, name), ignore_errors=True)

        record_sync_event_db('cloud_unmounted', name or cloud_id or storage_id, 'Vault')
        return jsonify({"success": True, "message": f'"{name}" unmounted from Vault!'})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        if conn:
            conn.close()


@vault_bp.route('/api/vault/delete-file', methods=['POST'])
def delete_vault_file():
    """Permanently deletes a file from Google Drive, OneDrive, SFTP/FTP, or Local Encrypted Vault."""
    from routes.cloud_routes import get_valid_account_token
    if not session.get('is_authenticated') or session.get('login_type') == 'qr_restricted':
        return jsonify({"success": False, "error": "Unauthorized or Restricted Mode!"}), 403

    data = request.get_json(silent=True) or {}
    provider = (data.get('provider') or 'local').lower()
    relative_path = (data.get('filename') or '').strip()
    cloud_id = (data.get('cloud_id') or '').strip()
    account_id = (data.get('account_id') or '').strip()
    storage_id = (data.get('storage_id') or '').strip()
    remote_path = (data.get('remote_path') or '').strip()

    try:
        if provider in ('sftp', 'ftp') and storage_id and remote_path:
            conn = None
            try:
                conn = get_db_connection()
                row = conn.execute("SELECT * FROM remote_storages WHERE storage_id = ?", (storage_id,)).fetchone()
                if not row:
                    return jsonify({"success": False, "error": "Hosting storage configuration not found."}), 404
                delete_remote_file(dict(row), remote_path)
            finally:
                if conn:
                    conn.close()

        elif provider in ('google', 'onedrive') and cloud_id:
            acc = get_cloud_account_db(account_id) if account_id else get_first_enabled_cloud_account_db()
            if not acc:
                return jsonify({"success": False, "error": "Cloud account not linked or disabled."}), 404
            token = get_valid_account_token(acc['account_id'])
            if not token:
                return jsonify({"success": False, "error": "Cloud session expired. Reconnect account first."}), 401

            headers = {'Authorization': f'Bearer {token}'}
            if provider == 'google':
                del_url = f"https://www.googleapis.com/drive/v3/files/{cloud_id}"
            else:
                del_url = f"https://graph.microsoft.com/v1.0/me/drive/items/{cloud_id}"

            r = requests.delete(del_url, headers=headers, timeout=20)
            if r.status_code not in (200, 204):
                return jsonify({"success": False, "error": f"Cloud provider rejected deletion ({r.status_code}): {r.text[:120]}"}), 502

            conn = None
            try:
                conn = get_db_connection()
                conn.execute("DELETE FROM imported_assets WHERE cloud_id = ?", (cloud_id,))
                for asset in conn.execute("SELECT cloud_id, children_data FROM imported_assets").fetchall():
                    if asset['children_data'] and cloud_id in asset['children_data']:
                        def prune_tree(nodes):
                            cleaned = []
                            for n in nodes:
                                if n.get('cloud_id') == cloud_id:
                                    continue
                                if n.get('children'):
                                    n['children'] = prune_tree(n['children'])
                                cleaned.append(n)
                            return cleaned
                        updated = prune_tree(json.loads(asset['children_data']))
                        conn.execute("UPDATE imported_assets SET children_data = ? WHERE cloud_id = ?", (json.dumps(updated), asset['cloud_id']))
                conn.commit()
            finally:
                if conn:
                    conn.close()

        elif relative_path:
            user_id = session.get('user_id', 'shared')
            user_root = os.path.join(DOCUMENTS_DIR, secure_filename(user_id))
            secure_path = os.path.normpath(os.path.join(user_root, relative_path.lstrip('/')))
            if not secure_path.startswith(os.path.normpath(user_root)) or not os.path.exists(secure_path):
                return jsonify({"success": False, "error": "File not found in encrypted vault."}), 404
            os.remove(secure_path)
        else:
            return jsonify({"success": False, "error": "Insufficient file identifiers to delete."}), 400

        if relative_path:
            remove_from_print_queue_db(relative_path)
        record_sync_event_db('file_deleted', os.path.basename(relative_path or remote_path or cloud_id), provider.upper())
        return jsonify({"success": True, "message": "File permanently deleted!"})

    except Exception as e:
        print(f"[UNIVERSAL FILE DELETE ERROR]: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


# ========================================================================
# 🖨️ "TO BE PRINTED" WISHLIST QUEUE & DIRECT CLOUD/REMOTE UPLOAD ENDPOINT
# ========================================================================
@vault_bp.route('/api/print-queue', methods=['GET', 'POST', 'DELETE'])
def manage_print_queue():
    """Handles reading, adding, and removing files from the To Be Printed wishlist."""
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized"}), 403
    try:
        if request.method == 'GET':
            return jsonify({"items": get_print_queue_db()})
        data = request.get_json(silent=True) or {}
        if request.method == 'POST':
            add_to_print_queue_db(data)
            record_sync_event_db('print_queue_updated', data.get('name', 'Document'), 'To Be Printed')
            return jsonify({"success": True})
        if request.method == 'DELETE':
            remove_from_print_queue_db(data.get('item_path'))
            record_sync_event_db('print_queue_updated', data.get('item_path', 'Document'), 'Removed from Print Queue')
            return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@vault_bp.route('/api/upload-file', methods=['POST'])
def upload_file_to_vault():
    """Uploads files directly into the active mounted Cloud Drive (Google/OneDrive) or SFTP/FTP folder."""
    from routes.cloud_routes import get_valid_account_token, invalidate_cloud_dir_cache
    if not session.get('is_authenticated') or session.get('login_type') == 'qr_restricted':
        return jsonify({"success": False, "error": "Unauthorized Access!"}), 403
    if 'file' not in request.files:
        return jsonify({"success": False, "error": "No file selected"}), 400

    file = request.files['file']
    target_folder = request.form.get('folder_path', '').strip('/')
    storage_id = (request.form.get('storage_id') or '').strip()
    remote_dir = (request.form.get('remote_dir') or '').strip()
    raw_cloud_folder_id = (request.form.get('cloud_folder_id') or '').strip()
    raw_account_id = (request.form.get('account_id') or '').strip()
    raw_provider = (request.form.get('provider') or '').strip().lower()

    if file.filename == '' or not allowed_file(file.filename):
        return jsonify({"success": False, "error": "Invalid file or unsupported extension!"}), 400

    filename = secure_filename(file.filename)
    raw_bytes = file.read()
    mimetype = file.mimetype or 'application/octet-stream'
    ext = filename.rsplit('.', 1)[1].lower()
    file_type = "notebook" if ext == 'ipynb' else ("pdf" if ext == 'pdf' else "image")

    # 1. Direct Upload to Active Hosting SFTP / FTP Folder
    if storage_id:
        conn = None
        try:
            conn = get_db_connection()
            row = conn.execute("SELECT * FROM remote_storages WHERE storage_id = ?", (storage_id,)).fetchone()
            if not row:
                return jsonify({"success": False, "error": "Remote storage not found"}), 404
            row_dict = dict(row)
            remote_file_path = upload_remote_file_bytes(
                row_dict, remote_dir or row_dict.get('base_path') or '/', filename, raw_bytes
            )
            record_sync_event_db('file_uploaded', filename, target_folder or row_dict['label'])
            return jsonify({
                "success": True,
                "file_item": {
                    "name": filename,
                    "type": "file",
                    "file_type": file_type,
                    "size": len(raw_bytes),
                    "remote_path": remote_file_path,
                    "storage_id": storage_id,
                    "provider": row_dict["protocol"],
                    "account_name": row_dict["label"]
                }
            }), 200
        except Exception as e:
            return jsonify({"success": False, "error": f"Remote upload failed: {e}"}), 500
        finally:
            if conn:
                conn.close()

    # 2. Direct Upload to Active Cloud Drive Folder (with automatic DB resolution fallback)
    cloud_folder_id, account_id, provider = _resolve_cloud_upload_target(
        raw_cloud_folder_id, raw_account_id, raw_provider, target_folder
    )

    if cloud_folder_id and account_id and provider in ('google', 'onedrive'):
        acc = get_cloud_account_db(account_id)
        if not acc:
            return jsonify({"success": False, "error": "Cloud account not found or disabled."}), 404
        token = get_valid_account_token(account_id)
        if not token:
            return jsonify({"success": False, "error": "Cloud session expired. Please reconnect your drive."}), 401

        acc_label = acc['custom_name'] or acc['email'] or acc['account_id']
        try:
            if provider == 'google':
                boundary = f"printsafe_{uuid.uuid4().hex}"
                metadata = json.dumps({"name": filename, "parents": [cloud_folder_id]}).encode('utf-8')
                body = (
                    f"--{boundary}\r\n"
                    f"Content-Type: application/json; charset=UTF-8\r\n\r\n"
                ).encode('utf-8') + metadata + (
                    f"\r\n--{boundary}\r\n"
                    f"Content-Type: {mimetype}\r\n\r\n"
                ).encode('utf-8') + raw_bytes + f"\r\n--{boundary}--".encode('utf-8')

                up_resp = requests.post(
                    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size",
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": f"multipart/related; boundary={boundary}"
                    },
                    data=body,
                    timeout=30
                )
                if not up_resp.ok:
                    return jsonify({"success": False, "error": f"Google Drive upload failed: {up_resp.text[:140]}"}), 502
                up_json = up_resp.json()
                uploaded_cloud_id = up_json.get("id")
                uploaded_size = int(up_json.get("size") or len(raw_bytes))
            else:
                up_url = (
                    f"https://graph.microsoft.com/v1.0/me/drive/root:/{filename}:/content"
                    if cloud_folder_id == "root"
                    else f"https://graph.microsoft.com/v1.0/me/drive/items/{cloud_folder_id}:/{filename}:/content"
                )
                up_resp = requests.put(
                    up_url,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": mimetype
                    },
                    data=raw_bytes,
                    timeout=30
                )
                if not up_resp.ok:
                    return jsonify({"success": False, "error": f"OneDrive upload failed: {up_resp.text[:140]}"}), 502
                up_json = up_resp.json()
                uploaded_cloud_id = up_json.get("id")
                uploaded_size = int(up_json.get("size") or len(raw_bytes))

            invalidate_cloud_dir_cache(account_id)
            file_item_payload = {
                "name": filename,
                "type": "file",
                "file_type": file_type,
                "size": uploaded_size,
                "cloud_id": uploaded_cloud_id,
                "account_id": account_id,
                "provider": provider,
                "account_name": acc_label
            }
            _append_item_to_imported_assets_db(account_id, provider, target_folder, file_item_payload)
            invalidate_cloud_dir_cache(account_id)
            record_sync_event_db('file_uploaded', filename, target_folder or acc_label)
            return jsonify({
                "success": True,
                "file_item": file_item_payload
            }), 200
        except Exception as e:
            return jsonify({"success": False, "error": f"Cloud upload error: {e}"}), 500

    return jsonify({
        "success": False,
        "error": "No connected Cloud Drive or SFTP/FTP folder found. Please connect a drive first."
    }), 400


@vault_bp.route('/api/create-folder', methods=['POST'])
def create_vault_subfolder():
    """Creates a dedicated subfolder inside active Google Drive, OneDrive, or SFTP/FTP folder."""
    from routes.cloud_routes import get_valid_account_token, invalidate_cloud_dir_cache
    if not session.get('is_authenticated') or session.get('login_type') == 'qr_restricted':
        return jsonify({"success": False, "error": "Unauthorized Access!"}), 403

    data = request.get_json(silent=True) or {}
    folder_name = secure_filename((data.get('folder_name') or '').strip()) or f"Scan_{int(time.time())}"
    target_folder = (data.get('folder_path') or '').strip('/')
    raw_provider = (data.get('provider') or '').strip().lower()
    raw_account_id = (data.get('account_id') or '').strip()
    raw_cloud_folder_id = (data.get('cloud_folder_id') or '').strip()
    storage_id = (data.get('storage_id') or '').strip()
    remote_dir = (data.get('remote_dir') or '/').strip()

    if storage_id:
        conn = None
        try:
            conn = get_db_connection()
            row = conn.execute("SELECT * FROM remote_storages WHERE storage_id = ?", (storage_id,)).fetchone()
            if not row:
                return jsonify({"success": False, "error": "Remote storage not found."}), 404
            row_dict = dict(row)
            base = remote_dir or row_dict.get("base_path") or "/"
            target_remote_path = f"{base.rstrip('/')}/{folder_name}"
            if row_dict["protocol"] == "sftp":
                import paramiko
                t = paramiko.Transport((row_dict["host"], int(row_dict["port"])))
                t.connect(username=row_dict["username"], password=decrypt_storage_password(row_dict["encrypted_secret"]))
                sftp = paramiko.SFTPClient.from_transport(t)
                try:
                    sftp.mkdir(target_remote_path)
                except IOError:
                    pass
                sftp.close()
                t.close()
            else:
                import ftplib
                ftp = ftplib.FTP()
                ftp.connect(row_dict["host"], int(row_dict["port"]), timeout=15)
                ftp.login(row_dict["username"], decrypt_storage_password(row_dict["encrypted_secret"]))
                try:
                    ftp.mkd(target_remote_path)
                except ftplib.error_perm:
                    pass
                ftp.quit()

            return jsonify({
                "success": True,
                "folder_item": {
                    "name": folder_name,
                    "type": "folder",
                    "file_type": "folder",
                    "storage_id": storage_id,
                    "remote_path": target_remote_path,
                    "provider": row_dict["protocol"],
                    "account_name": row_dict["label"],
                    "children": []
                }
            }), 200
        except Exception as e:
            return jsonify({"success": False, "error": str(e)}), 500
        finally:
            if conn:
                conn.close()

    cloud_folder_id, account_id, provider = _resolve_cloud_upload_target(
        raw_cloud_folder_id, raw_account_id, raw_provider, target_folder
    )

    if account_id and provider in ('google', 'onedrive'):
        acc = get_cloud_account_db(account_id)
        if not acc:
            return jsonify({"success": False, "error": "Cloud account not found."}), 404
        token = get_valid_account_token(account_id)
        if not token:
            return jsonify({"success": False, "error": "Cloud session expired."}), 401

        acc_label = acc['custom_name'] or acc['email'] or acc['account_id']
        try:
            if provider == 'google':
                resp = requests.post(
                    "https://www.googleapis.com/drive/v3/files?fields=id,name",
                    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                    json={
                        "name": folder_name,
                        "mimeType": "application/vnd.google-apps.folder",
                        "parents": [cloud_folder_id]
                    },
                    timeout=20
                )
                if not resp.ok:
                    return jsonify({"success": False, "error": f"Google folder creation failed: {resp.text[:120]}"}), 502
                new_id = resp.json().get("id")
            else:
                url = (
                    "https://graph.microsoft.com/v1.0/me/drive/root/children"
                    if cloud_folder_id == "root"
                    else f"https://graph.microsoft.com/v1.0/me/drive/items/{cloud_folder_id}/children"
                )
                resp = requests.post(
                    url,
                    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                    json={"name": folder_name, "folder": {}, "@microsoft.graph.conflictBehavior": "rename"},
                    timeout=20
                )
                if not resp.ok:
                    return jsonify({"success": False, "error": f"OneDrive folder creation failed: {resp.text[:120]}"}), 502
                j = resp.json()
                new_id = j.get("id")
                folder_name = j.get("name", folder_name)

            invalidate_cloud_dir_cache(account_id)
            folder_item_payload = {
                "name": folder_name,
                "type": "folder",
                "file_type": "folder",
                "cloud_id": new_id,
                "account_id": account_id,
                "provider": provider,
                "account_name": acc_label,
                "children": []
            }
            _append_item_to_imported_assets_db(account_id, provider, target_folder, folder_item_payload)
            invalidate_cloud_dir_cache(account_id)
            record_sync_event_db('folder_created', folder_name, target_folder or acc_label)
            return jsonify({
                "success": True,
                "folder_item": folder_item_payload
            }), 200
        except Exception as e:
            return jsonify({"success": False, "error": str(e)}), 500

    return jsonify({"success": False, "error": "No connected Cloud Drive or SFTP/FTP storage found."}), 400


# ========================================================================
# 📂 FETCH USER VAULT TREE & IN-MEMORY STREAMING
# ========================================================================
@vault_bp.route('/fetch-vault-list', methods=['POST'])
def fetch_vault_list():
    """Builds the unified directory tree from User Vault, Cloud Drives, and Active SFTP/FTP."""
    from routes.cloud_routes import get_valid_account_token
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
            if 'owner_id' in qr_row.keys() and qr_row['owner_id']:
                session['user_id'] = qr_row['owner_id']

    if not is_session_valid:
        return jsonify({"error": "Unauthorized Access!"}), 403

    owner_id = session.get('user_id', 'shared')
    vault_tree = []

    user_root = os.path.join(DOCUMENTS_DIR, secure_filename(owner_id))
    if os.path.exists(user_root):
        def scan_user_dir(curr):
            res = []
            try:
                for entry in os.scandir(curr):
                    ext = entry.name.split('.')[-1].lower() if '.' in entry.name else ''
                    if entry.is_dir():
                        res.append({
                            "name": entry.name, "type": "folder", "children": scan_user_dir(entry.path),
                            "provider": "local", "account_name": "Encrypted Vault", "is_expired": False
                        })
                    elif entry.is_file() and ext in ALLOWED_EXTENSIONS:
                        res.append({
                            "name": entry.name, "type": "file",
                            "file_type": "notebook" if ext == 'ipynb' else ("pdf" if ext == 'pdf' else "image"),
                            "size": entry.stat().st_size, "provider": "local",
                            "account_name": "Encrypted Vault", "is_expired": False
                        })
            except OSError:
                pass
            return sorted(res, key=lambda x: (x['type'] != 'folder', x['name'].lower()))
        vault_tree.extend(scan_user_dir(user_root))

    # Mounted Cloud Drive Assets (Instant SQLite Cache-First Read — 0 Blocking Cloud API Calls on Refresh)
    try:
        acc_map = {}
        disabled_providers = set()
        enabled_providers = set()

        for r in get_all_cloud_accounts_db():
            acc_id = r["account_id"]
            is_en = bool(r["is_enabled"])
            prov = (r["provider"] or "google").lower()
            if is_en:
                enabled_providers.add(prov)
            else:
                disabled_providers.add(prov)

            tok = get_valid_account_token(acc_id) if is_en else None
            acc_map[acc_id] = {
                "name": r["custom_name"] if r["custom_name"] else r["email"],
                "enabled": is_en,
                "expired": (is_en and tok is None),
                "provider": prov
            }

        for row in get_all_imported_assets_db():
            acc_id = row["account_id"]
            prov = (row["provider"] or "google").lower()

            if acc_id and acc_id in acc_map:
                if not acc_map[acc_id]["enabled"]:
                    continue
            elif prov in disabled_providers and prov not in enabled_providers:
                continue

            is_expired = acc_map[acc_id]["expired"] if (acc_id and acc_id in acc_map) else False
            effective_acc_name = (
                acc_map[acc_id]["name"]
                if (acc_id and acc_id in acc_map)
                else (row["account_name"] or ("Google Drive" if prov == "google" else "OneDrive"))
            )
            inner_children = []
            try:
                if row["children_data"] and not is_expired:
                    inner_children = json.loads(row["children_data"])
            except Exception:
                inner_children = []

            vault_tree.append({
                "name": row["name"],
                "type": row["type"],
                "file_type": "folder" if row["type"] == 'folder' else "pdf",
                "size": 0,
                "children": inner_children,
                "cloud_id": row["cloud_id"],
                "provider": prov,
                "account_id": acc_id or "",
                "account_name": effective_acc_name,
                "is_expired": is_expired
            })
    except Exception as e:
        print(f"[CLOUD MERGE WARNING]: {e}")

    conn = None
    try:
        conn = get_db_connection()
        remotes = conn.execute(
            """
            SELECT * FROM remote_storages
            WHERE (owner_id = ? OR owner_id = 'user' OR owner_id IS NULL) AND is_enabled = 1
            """,
            (owner_id,)
        ).fetchall()
        for rem in remotes:
            rem_dict = dict(rem)
            children = list_remote_directory(rem_dict)
            vault_tree.append({
                "name": rem_dict["label"], "type": "folder", "file_type": "folder",
                "size": 0, "children": children, "storage_id": rem_dict["storage_id"],
                "remote_path": rem_dict["base_path"] or "/",
                "provider": rem_dict["protocol"],
                "account_name": f"{rem_dict['protocol'].upper()} • {rem_dict['host']}",
                "is_expired": False
            })
    except Exception as e:
        print(f"[REMOTE STORAGE TREE WARNING]: {e}")
    finally:
        if conn:
            conn.close()

    return jsonify({"tree": vault_tree})


@vault_bp.route('/fetch-file-data', methods=['POST'])
def fetch_file_data():
    """Streams file bytes from Hosting SFTP/FTP, Cloud Drives, or User Encrypted Vault."""
    from routes.cloud_routes import get_valid_account_token
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized Access!"}), 403

    data = request.get_json(silent=True) or {}
    relative_path = data.get('filename')
    cloud_id = data.get('cloud_id')
    account_id = data.get('account_id')
    storage_id = data.get('storage_id')
    remote_path = data.get('remote_path')

    if storage_id and remote_path:
        conn = None
        try:
            conn = get_db_connection()
            row = conn.execute("SELECT * FROM remote_storages WHERE storage_id = ?", (storage_id,)).fetchone()
            if row:
                raw_bytes = download_remote_file_bytes(dict(row), remote_path)
                return jsonify({"base64": base64.b64encode(raw_bytes).decode('utf-8')}), 200
        except Exception as e:
            return jsonify({"error": f"Remote storage stream error: {e}"}), 502
        finally:
            if conn:
                conn.close()

    if cloud_id:
        try:
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
                        return jsonify({"base64": base64.b64encode(r.content).decode('utf-8')}), 200
        except Exception as e:
            return jsonify({"error": str(e)}), 502

    if relative_path:
        user_id = session.get('user_id', 'shared')
        user_root = os.path.join(DOCUMENTS_DIR, secure_filename(user_id))
        secure_path = os.path.normpath(os.path.join(user_root, relative_path.lstrip('/')))
        if secure_path.startswith(os.path.normpath(user_root)) and os.path.exists(secure_path):
            try:
                with open(secure_path, "rb") as f:
                    dec = decrypt_bytes(f.read())
                return jsonify({"base64": base64.b64encode(dec).decode('utf-8')}), 200
            except Exception as e:
                return jsonify({"error": str(e)}), 500

    return jsonify({"error": "File not found!"}), 404