import os
import sqlite3
import time
import uuid
import json
from dotenv import load_dotenv
from werkzeug.security import generate_password_hash

load_dotenv()
DB_PATH = os.getenv('DATABASE_PATH', 'secure_vault.db')
DEFAULT_SECRET = os.getenv('SECRET_PRINT_PASSWORD', 'admin123')


def get_db_connection():
    conn = sqlite3.connect(DB_PATH, timeout=20)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()

    # 1. Master System Config
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS system_config (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    ''')
    cursor.execute("SELECT value FROM system_config WHERE key = 'master_password'")
    if not cursor.fetchone():
        cursor.execute(
            "INSERT INTO system_config (key, value) VALUES ('master_password', ?)",
            (generate_password_hash(DEFAULT_SECRET),)
        )

    # 2. Multi-Account Cloud Providers Table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS cloud_accounts (
            account_id TEXT PRIMARY KEY,
            provider TEXT,
            custom_name TEXT,
            email TEXT,
            access_token TEXT,
            refresh_token TEXT,
            expires_at REAL,
            is_enabled INTEGER DEFAULT 1,
            token_status TEXT DEFAULT 'valid',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    cursor.execute("PRAGMA table_info(cloud_accounts)")
    ca_cols = [c[1] for c in cursor.fetchall()]
    if 'token_status' not in ca_cols:
        cursor.execute("ALTER TABLE cloud_accounts ADD COLUMN token_status TEXT DEFAULT 'valid'")

    # 3. Imported Cloud Folders & Files Table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS imported_assets (
            cloud_id TEXT PRIMARY KEY,
            name TEXT,
            type TEXT,
            children_data TEXT,
            session_id TEXT,
            provider TEXT DEFAULT 'google',
            account_id TEXT DEFAULT '',
            account_name TEXT DEFAULT 'Cloud Drive'
        )
    ''')
    cursor.execute("PRAGMA table_info(imported_assets)")
    ia_cols = [c[1] for c in cursor.fetchall()]
    for col, default_val in [('provider', "'google'"), ('account_id', "''"), ('account_name', "'Cloud Drive'")]:
        if col not in ia_cols:
            cursor.execute(f"ALTER TABLE imported_assets ADD COLUMN {col} TEXT DEFAULT {default_val}")

    # 4. QR Sessions & Remote Restrictions Table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS secure_qr_vault (
            session_id TEXT PRIMARY KEY,
            status TEXT,
            created_at REAL,
            device_info TEXT DEFAULT 'Desktop Browser',
            is_restricted INTEGER DEFAULT 1,
            mask_folders INTEGER DEFAULT 0,
            disable_profile INTEGER DEFAULT 1,
            allow_print INTEGER DEFAULT 1
        )
    ''')
    cursor.execute("PRAGMA table_info(secure_qr_vault)")
    qr_cols = [c[1] for c in cursor.fetchall()]
    for col_name, col_def in [
        ("device_info", "TEXT DEFAULT 'Desktop Browser'"),
        ("is_restricted", "INTEGER DEFAULT 1"),
        ("mask_folders", "INTEGER DEFAULT 0"),
        ("disable_profile", "INTEGER DEFAULT 1"),
        ("allow_print", "INTEGER DEFAULT 1")
    ]:
        if col_name not in qr_cols:
            cursor.execute(f"ALTER TABLE secure_qr_vault ADD COLUMN {col_name} {col_def}")

    # 5. "To Be Printed" Wishlist Queue Table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS print_queue (
            item_path TEXT PRIMARY KEY,
            name TEXT,
            file_type TEXT,
            size INTEGER DEFAULT 0,
            cloud_id TEXT DEFAULT '',
            account_id TEXT DEFAULT '',
            account_name TEXT DEFAULT 'Local Vault',
            provider TEXT DEFAULT 'local',
            added_at REAL
        )
    ''')

    # 6. Universal Real-Time Sync Events Table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS vault_sync_events (
            event_id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT,
            filename TEXT,
            folder_path TEXT,
            created_at REAL
        )
    ''')

    conn.commit()
    conn.close()


# ========================================================================
# 🔐 MASTER PASSWORD & CONFIG HELPERS
# ========================================================================
def get_stored_password_hash():
    try:
        conn = get_db_connection()
        row = conn.execute("SELECT value FROM system_config WHERE key = 'master_password'").fetchone()
        conn.close()
        return row['value'] if row else None
    except Exception:
        return None


def update_master_password(new_password):
    try:
        conn = get_db_connection()
        conn.execute(
            "INSERT OR REPLACE INTO system_config (key, value) VALUES ('master_password', ?)",
            (generate_password_hash(new_password),)
        )
        conn.commit()
        conn.close()
        return True, "Master password updated successfully!"
    except Exception as e:
        return False, str(e)


# ========================================================================
# 📱 QR SESSIONS & REMOTE RESTRICTIONS DB OPERATIONS
# ========================================================================
def create_qr_session_db(device_label="Desktop"):
    now = time.time()
    session_id = str(uuid.uuid4())
    conn = get_db_connection()
    conn.execute("DELETE FROM secure_qr_vault WHERE status = 'pending' AND ? - created_at > 30", (now,))
    conn.execute('''
        INSERT INTO secure_qr_vault 
        (session_id, status, created_at, device_info, is_restricted, mask_folders, disable_profile, allow_print) 
        VALUES (?, 'pending', ?, ?, 1, 0, 1, 1)
    ''', (session_id, now, device_label))
    conn.commit()
    conn.close()
    return session_id


def get_qr_session_db(session_id):
    conn = get_db_connection()
    row = conn.execute('''
        SELECT session_id, status, created_at, device_info, is_restricted, mask_folders, disable_profile, allow_print 
        FROM secure_qr_vault WHERE session_id = ?
    ''', (session_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def approve_qr_session_db(session_id):
    conn = get_db_connection()
    conn.execute('''
        UPDATE secure_qr_vault 
        SET status = 'authenticated', created_at = ?, is_restricted = 1, disable_profile = 1 
        WHERE session_id = ?
    ''', (time.time(), session_id))
    conn.commit()
    conn.close()


def list_authenticated_qr_sessions_db():
    conn = get_db_connection()
    rows = conn.execute('''
        SELECT session_id, device_info, created_at, is_restricted, mask_folders, disable_profile, allow_print 
        FROM secure_qr_vault WHERE status = 'authenticated' ORDER BY created_at DESC
    ''').fetchall()
    conn.close()
    return [{
        "session_id": r["session_id"],
        "device_info": r["device_info"] or "Desktop Session",
        "connected_at": r["created_at"],
        "is_restricted": bool(r["is_restricted"]),
        "mask_folders": bool(r["mask_folders"]),
        "disable_profile": bool(r["disable_profile"]),
        "allow_print": bool(r["allow_print"])
    } for r in rows]


def update_qr_restriction_field_db(session_id, field, bool_val):
    if field not in ['is_restricted', 'mask_folders', 'disable_profile', 'allow_print']:
        return False
    val = 1 if bool_val else 0
    conn = get_db_connection()
    if session_id == 'all':
        conn.execute(f"UPDATE secure_qr_vault SET {field} = ? WHERE status = 'authenticated'", (val,))
    else:
        conn.execute(f"UPDATE secure_qr_vault SET {field} = ? WHERE session_id = ?", (val, session_id))
    conn.commit()
    conn.close()
    return True


def terminate_qr_session_db(session_id='all'):
    conn = get_db_connection()
    if session_id == 'all' or not session_id:
        conn.execute("UPDATE secure_qr_vault SET status = 'terminated' WHERE status = 'authenticated'")
    else:
        conn.execute("UPDATE secure_qr_vault SET status = 'terminated' WHERE session_id = ?", (session_id,))
    conn.commit()
    conn.close()


# ========================================================================
# ☁️ MULTI-ACCOUNT CLOUD DB OPERATIONS
# ========================================================================
def get_cloud_account_db(account_id):
    conn = get_db_connection()
    row = conn.execute("SELECT * FROM cloud_accounts WHERE account_id = ?", (account_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_first_enabled_cloud_account_db():
    conn = get_db_connection()
    row = conn.execute("SELECT * FROM cloud_accounts WHERE is_enabled = 1 LIMIT 1").fetchone()
    conn.close()
    return dict(row) if row else None


def get_all_cloud_accounts_db():
    conn = get_db_connection()
    rows = conn.execute("SELECT * FROM cloud_accounts ORDER BY created_at DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def save_or_update_cloud_account_db(provider, email, custom_name, access_token, refresh_token, expires_at):
    conn = get_db_connection()
    existing = conn.execute(
        "SELECT account_id, refresh_token, custom_name FROM cloud_accounts WHERE provider = ? AND email = ?",
        (provider, email)
    ).fetchone()

    final_display = custom_name if custom_name else email
    if existing:
        acc_id = existing["account_id"]
        final_refresh = refresh_token if refresh_token else existing["refresh_token"]
        name_to_save = custom_name if custom_name else (existing["custom_name"] or email)
        conn.execute('''
            UPDATE cloud_accounts
            SET access_token = ?, refresh_token = ?, expires_at = ?, custom_name = ?, is_enabled = 1, token_status = 'valid'
            WHERE account_id = ?
        ''', (access_token, final_refresh, expires_at, name_to_save, acc_id))
    else:
        prefix = "goog_" if provider == "google" else "oned_"
        acc_id = f"{prefix}{uuid.uuid4().hex[:8]}"
        conn.execute('''
            INSERT INTO cloud_accounts 
            (account_id, provider, custom_name, email, access_token, refresh_token, expires_at, is_enabled, token_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'valid')
        ''', (acc_id, provider, final_display, email, access_token, refresh_token, expires_at))
    conn.commit()
    conn.close()
    return acc_id


def update_cloud_account_tokens_db(account_id, access_token, refresh_token, expires_at, status='valid'):
    conn = get_db_connection()
    conn.execute('''
        UPDATE cloud_accounts
        SET access_token = ?, refresh_token = ?, expires_at = ?, token_status = ?
        WHERE account_id = ?
    ''', (access_token, refresh_token, expires_at, status, account_id))
    conn.commit()
    conn.close()


def set_cloud_account_status_db(account_id, status):
    conn = get_db_connection()
    conn.execute("UPDATE cloud_accounts SET token_status = ? WHERE account_id = ?", (status, account_id))
    conn.commit()
    conn.close()


def modify_cloud_account_db(account_id, action, value=None):
    conn = get_db_connection()
    if action == 'toggle':
        conn.execute("UPDATE cloud_accounts SET is_enabled = ? WHERE account_id = ?", (1 if value else 0, account_id))
    elif action == 'rename':
        row = conn.execute("SELECT email FROM cloud_accounts WHERE account_id = ?", (account_id,)).fetchone()
        final_name = value if value else (row['email'] if row else "Cloud Drive")
        conn.execute("UPDATE cloud_accounts SET custom_name = ? WHERE account_id = ?", (final_name, account_id))
        conn.execute("UPDATE imported_assets SET account_name = ? WHERE account_id = ?", (final_name, account_id))
    elif action == 'delete':
        conn.execute("DELETE FROM cloud_accounts WHERE account_id = ?", (account_id,))
        conn.execute("DELETE FROM imported_assets WHERE account_id = ?", (account_id,))
    conn.commit()
    conn.close()


# ========================================================================
# 📂 IMPORTED CLOUD ASSETS & PRINT QUEUE DB OPERATIONS
# ========================================================================
def save_imported_asset_db(cloud_id, name, asset_type, children_tree, provider, account_id, account_name):
    conn = get_db_connection()
    conn.execute('''
        INSERT OR REPLACE INTO imported_assets 
        (cloud_id, name, type, children_data, session_id, provider, account_id, account_name)
        VALUES (?, ?, ?, ?, 'core_authenticated_user', ?, ?, ?)
    ''', (cloud_id, name, asset_type, json.dumps(children_tree), provider, account_id, account_name))
    conn.commit()
    conn.close()


def get_all_imported_assets_db():
    conn = get_db_connection()
    rows = conn.execute("SELECT * FROM imported_assets").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_print_queue_db():
    conn = get_db_connection()
    rows = conn.execute("SELECT * FROM print_queue ORDER BY added_at DESC").fetchall()
    conn.close()
    return [{
        "item_path": r["item_path"], "name": r["name"], "type": "file", "file_type": r["file_type"],
        "size": r["size"], "cloud_id": r["cloud_id"], "account_id": r["account_id"],
        "account_name": r["account_name"], "provider": r["provider"]
    } for r in rows]


def add_to_print_queue_db(data):
    conn = get_db_connection()
    conn.execute('''
        INSERT OR REPLACE INTO print_queue 
        (item_path, name, file_type, size, cloud_id, account_id, account_name, provider, added_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (
        data.get('item_path'), data.get('name'), data.get('file_type', 'pdf'),
        int(data.get('size', 0)), data.get('cloud_id', ''),
        data.get('account_id', ''), data.get('account_name', 'Local Vault'),
        data.get('provider', 'local'), time.time()
    ))
    conn.commit()
    conn.close()


def remove_from_print_queue_db(item_path):
    conn = get_db_connection()
    if item_path == 'all':
        conn.execute("DELETE FROM print_queue")
    else:
        conn.execute("DELETE FROM print_queue WHERE item_path = ?", (item_path,))
    conn.commit()
    conn.close()


# ========================================================================
# ⚡ REAL-TIME UPLOAD SYNC EVENTS DB OPERATIONS
# ========================================================================
def record_sync_event_db(event_type, filename, folder_path):
    conn = get_db_connection()
    conn.execute('''
        INSERT INTO vault_sync_events (event_type, filename, folder_path, created_at)
        VALUES (?, ?, ?, ?)
    ''', (event_type, filename, folder_path or 'Root Vault', time.time()))
    conn.commit()
    conn.close()


def get_latest_sync_state_db():
    conn = get_db_connection()
    ev = conn.execute("SELECT MAX(event_id) as id, filename, folder_path, created_at FROM vault_sync_events").fetchone()
    cnt = conn.execute("SELECT COUNT(*) as c FROM secure_qr_vault WHERE status = 'authenticated'").fetchone()
    conn.close()
    latest = None
    if ev and ev["id"]:
        latest = {
            "event_id": ev["id"],
            "filename": ev["filename"],
            "folder_path": ev["folder_path"],
            "created_at": ev["created_at"]
        }
    return latest, (cnt["c"] if cnt else 0)