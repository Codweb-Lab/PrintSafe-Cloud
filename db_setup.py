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
    """Creates and returns a SQLite connection with Row factory and busy timeout."""
    conn = sqlite3.connect(DB_PATH, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    return conn


def init_db():
    """Upgrades existing database tables and initializes Notifications, Feature Flags & SaaS Schema."""
    conn = None
    try:
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
                owner_id TEXT DEFAULT 'admin',
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
        for col_name, col_def in [('token_status', "TEXT DEFAULT 'valid'"), ('owner_id', "TEXT DEFAULT 'admin'")]:
            if col_name not in ca_cols:
                cursor.execute(f"ALTER TABLE cloud_accounts ADD COLUMN {col_name} {col_def}")

        # 3. Imported Cloud Folders & Files Table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS imported_assets (
                cloud_id TEXT PRIMARY KEY,
                owner_id TEXT DEFAULT 'admin',
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
        for col, default_val in [
            ('provider', "'google'"),
            ('account_id', "''"),
            ('account_name', "'Cloud Drive'"),
            ('owner_id', "'admin'")
        ]:
            if col not in ia_cols:
                cursor.execute(f"ALTER TABLE imported_assets ADD COLUMN {col} TEXT DEFAULT {default_val}")

        # 4. QR Sessions & Remote Restrictions Table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS secure_qr_vault (
                session_id TEXT PRIMARY KEY,
                owner_id TEXT DEFAULT 'admin',
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
            ("owner_id", "TEXT DEFAULT 'admin'"),
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
                owner_id TEXT DEFAULT 'admin',
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
        cursor.execute("PRAGMA table_info(print_queue)")
        pq_cols = [c[1] for c in cursor.fetchall()]
        if 'owner_id' not in pq_cols:
            cursor.execute("ALTER TABLE print_queue ADD COLUMN owner_id TEXT DEFAULT 'admin'")

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

        # 7. Upgraded Multi-User Accounts Table (With Profile Bio/Phone & Security Columns)
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS users (
                user_id TEXT PRIMARY KEY,
                full_name TEXT DEFAULT '',
                email TEXT UNIQUE,
                phone TEXT DEFAULT '',
                bio TEXT DEFAULT '',
                password_hash TEXT,
                pin_hash TEXT DEFAULT '',
                totp_secret TEXT DEFAULT '',
                totp_enabled INTEGER DEFAULT 0,
                auth_provider TEXT DEFAULT 'local',
                role TEXT DEFAULT 'user',
                is_verified INTEGER DEFAULT 1,
                storage_quota_mb INTEGER DEFAULT 500,
                created_at REAL
            )
        ''')
        cursor.execute("PRAGMA table_info(users)")
        u_cols = [c[1] for c in cursor.fetchall()]
        for col_name, col_def in [
            ("phone", "TEXT DEFAULT ''"),
            ("bio", "TEXT DEFAULT ''"),
            ("pin_hash", "TEXT DEFAULT ''"),
            ("totp_secret", "TEXT DEFAULT ''"),
            ("totp_enabled", "INTEGER DEFAULT 0"),
            ("is_verified", "INTEGER DEFAULT 1"),
            ("storage_quota_mb", "INTEGER DEFAULT 500")
        ]:
            if col_name not in u_cols:
                cursor.execute(f"ALTER TABLE users ADD COLUMN {col_name} {col_def}")

        # 8. Email OTP Verification Table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS email_otps (
                email TEXT PRIMARY KEY,
                otp_code TEXT,
                purpose TEXT DEFAULT 'register',
                expires_at REAL
            )
        ''')
        cursor.execute("PRAGMA table_info(email_otps)")
        otp_cols = [c[1] for c in cursor.fetchall()]
        if 'purpose' not in otp_cols:
            cursor.execute("ALTER TABLE email_otps ADD COLUMN purpose TEXT DEFAULT 'register'")

        # 9. Custom Hosting Storage Connections (SSH/SFTP & FTP)
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS remote_storages (
                storage_id TEXT PRIMARY KEY,
                owner_id TEXT,
                label TEXT,
                protocol TEXT DEFAULT 'sftp',
                host TEXT,
                port INTEGER DEFAULT 22,
                username TEXT,
                encrypted_secret TEXT,
                base_path TEXT DEFAULT '/',
                is_enabled INTEGER DEFAULT 1,
                created_at REAL
            )
        ''')

        # 10. Admin Feature Flags Table (Controls User Visibility & Rollout Notifications)
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS feature_flags (
                feature_key TEXT PRIMARY KEY,
                feature_name TEXT,
                description TEXT,
                is_enabled INTEGER DEFAULT 1,
                updated_at REAL
            )
        ''')

        default_features = [
            ("user_registration", "New User Registration", "Allow new users to sign up via Email OTP.", 1),
            ("google_oauth_login", "Google OAuth Sign-In", "Allow users to sign in/up using Google OAuth 2.0.", 0),
            ("cloud_drive_mount", "Cloud Drive Mounting", "Allow users to connect Google Drive & OneDrive.", 1),
            ("hosting_sftp_ftp", "Hosting SFTP / FTP Storage", "Allow users to mount custom SSH/SFTP & FTP storage.", 1),
            ("qr_desktop_pairing", "QR Desktop Pairing", "Allow users to unlock desktop sessions via mobile QR.", 1),
            ("two_factor_auth", "Authenticator App 2FA", "Allow users to enable Google/Microsoft Authenticator 2FA.", 1),
            ("print_wishlist_queue", "To Be Printed Queue", "Allow users to queue documents for zero-trace printing.", 1)
        ]
        for f_key, f_name, f_desc, f_def in default_features:
            cursor.execute('''
                INSERT OR IGNORE INTO feature_flags (feature_key, feature_name, description, is_enabled, updated_at)
                VALUES (?, ?, ?, ?, ?)
            ''', (f_key, f_name, f_desc, f_def, time.time()))

        # 11. User Notification Center Table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS notifications (
                notif_id INTEGER PRIMARY KEY AUTOINCREMENT,
                target_user_id TEXT DEFAULT 'all',
                title TEXT,
                message TEXT,
                category TEXT DEFAULT 'feature',
                is_read INTEGER DEFAULT 0,
                created_at REAL
            )
        ''')

        conn.commit()
    except sqlite3.Error as e:
        print(f"[DB INIT ERROR]: {e}")
    finally:
        if conn:
            conn.close()


# ========================================================================
# ⚙️ SYSTEM CONFIG & ENCRYPTED SECRET HELPERS
# ========================================================================
def get_system_config_db(key, default=""):
    conn = None
    try:
        conn = get_db_connection()
        row = conn.execute("SELECT value FROM system_config WHERE key = ?", (key,)).fetchone()
        return row['value'] if row and row['value'] is not None else default
    except sqlite3.Error:
        return default
    finally:
        if conn:
            conn.close()


def set_system_config_db(key, value):
    conn = None
    try:
        conn = get_db_connection()
        conn.execute(
            "INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)",
            (key, str(value).strip() if value is not None else "")
        )
        conn.commit()
        return True
    except sqlite3.Error as e:
        print(f"[CONFIG SAVE ERROR]: {e}")
        return False
    finally:
        if conn:
            conn.close()


def set_encrypted_config_db(key, plain_value):
    """Encrypts sensitive OAuth Client IDs/Secrets using AES-256 before storing in SQLite."""
    from vault_crypto import encrypt_bytes
    if not plain_value:
        return False
    enc_str = encrypt_bytes(plain_value.strip().encode("utf-8")).decode("utf-8")
    return set_system_config_db(key, enc_str)


def get_decrypted_config_db(key, default=""):
    """Decrypts AES-256 stored OAuth Client IDs/Secrets in memory."""
    from vault_crypto import decrypt_bytes
    raw = get_system_config_db(key, "")
    if not raw:
        return default
    try:
        return decrypt_bytes(raw.encode("utf-8")).decode("utf-8")
    except Exception:
        return raw


# ========================================================================
# 🎛️ FEATURE FLAGS & USER NOTIFICATIONS HELPERS
# ========================================================================
def get_all_feature_flags_db():
    conn = None
    try:
        conn = get_db_connection()
        rows = conn.execute("SELECT * FROM feature_flags ORDER BY rowid ASC").fetchall()
        return [dict(r) for r in rows]
    except sqlite3.Error:
        return []
    finally:
        if conn:
            conn.close()


def get_feature_flags_map_db():
    return {f["feature_key"]: bool(f["is_enabled"]) for f in get_all_feature_flags_db()}


def push_notification_db(target_user_id, title, message, category="system"):
    conn = None
    try:
        conn = get_db_connection()
        conn.execute(
            "INSERT INTO notifications (target_user_id, title, message, category, is_read, created_at) VALUES (?, ?, ?, ?, 0, ?)",
            (target_user_id, title, message, category, time.time())
        )
        conn.commit()
    except sqlite3.Error as e:
        print(f"[NOTIFICATION INSERT ERROR]: {e}")
    finally:
        if conn:
            conn.close()


def toggle_feature_flag_db(feature_key, is_enabled):
    conn = None
    try:
        conn = get_db_connection()
        row = conn.execute("SELECT feature_name, description FROM feature_flags WHERE feature_key = ?", (feature_key,)).fetchone()
        if not row:
            return False
        val = 1 if is_enabled else 0
        conn.execute(
            "UPDATE feature_flags SET is_enabled = ?, updated_at = ? WHERE feature_key = ?",
            (val, time.time(), feature_key)
        )
        conn.commit()

        # Notify all users immediately when Admin enables a feature
        if val == 1:
            push_notification_db(
                "all",
                f"New Feature Enabled: {row['feature_name']}",
                row["description"] or f"{row['feature_name']} is now available in your workspace!",
                "feature"
            )
        return True
    except sqlite3.Error as e:
        print(f"[FEATURE TOGGLE ERROR]: {e}")
        return False
    finally:
        if conn:
            conn.close()

# ========================================================================
# 🔐 MASTER PASSWORD & CONFIG HELPERS
# ========================================================================
def get_stored_password_hash():
    """Returns the hashed master vault password from SQLite."""
    conn = None
    try:
        conn = get_db_connection()
        row = conn.execute("SELECT value FROM system_config WHERE key = 'master_password'").fetchone()
        return row['value'] if row else None
    except sqlite3.Error as e:
        print(f"[PASSWORD FETCH ERROR]: {e}")
        return None
    finally:
        if conn:
            conn.close()


def update_master_password(new_password):
    """Updates the hashed master vault password in SQLite."""
    conn = None
    try:
        conn = get_db_connection()
        conn.execute(
            "INSERT OR REPLACE INTO system_config (key, value) VALUES ('master_password', ?)",
            (generate_password_hash(new_password),)
        )
        conn.commit()
        return True, "Master password updated successfully!"
    except sqlite3.Error as e:
        return False, f"Database error: {e}"
    finally:
        if conn:
            conn.close()


# ========================================================================
# 📱 QR SESSIONS & REMOTE RESTRICTIONS DB OPERATIONS
# ========================================================================
def create_qr_session_db(device_label="Desktop"):
    """Creates a new pending QR pairing session and purges stale pending rows."""
    now = time.time()
    session_id = str(uuid.uuid4())
    conn = None
    try:
        conn = get_db_connection()
        conn.execute("DELETE FROM secure_qr_vault WHERE status = 'pending' AND ? - created_at > 30", (now,))
        conn.execute('''
            INSERT INTO secure_qr_vault 
            (session_id, status, created_at, device_info, is_restricted, mask_folders, disable_profile, allow_print) 
            VALUES (?, 'pending', ?, ?, 1, 0, 1, 1)
        ''', (session_id, now, device_label))
        conn.commit()
        return session_id
    except sqlite3.Error as e:
        print(f"[QR CREATE ERROR]: {e}")
        raise
    finally:
        if conn:
            conn.close()


def get_qr_session_db(session_id):
    """Fetches a QR session record by session_id."""
    conn = None
    try:
        conn = get_db_connection()
        row = conn.execute('''
            SELECT session_id, status, created_at, device_info, is_restricted, mask_folders, disable_profile, allow_print 
            FROM secure_qr_vault WHERE session_id = ?
        ''', (session_id,)).fetchone()
        return dict(row) if row else None
    except sqlite3.Error as e:
        print(f"[QR FETCH ERROR]: {e}")
        return None
    finally:
        if conn:
            conn.close()


def approve_qr_session_db(session_id):
    """Marks a pending QR session as authenticated in restricted mode."""
    conn = None
    try:
        conn = get_db_connection()
        conn.execute('''
            UPDATE secure_qr_vault 
            SET status = 'authenticated', created_at = ?, is_restricted = 1, disable_profile = 1 
            WHERE session_id = ?
        ''', (time.time(), session_id))
        conn.commit()
    except sqlite3.Error as e:
        print(f"[QR APPROVE ERROR]: {e}")
    finally:
        if conn:
            conn.close()


def list_authenticated_qr_sessions_db():
    """Returns all currently active paired desktop sessions."""
    conn = None
    try:
        conn = get_db_connection()
        rows = conn.execute('''
            SELECT session_id, device_info, created_at, is_restricted, mask_folders, disable_profile, allow_print 
            FROM secure_qr_vault WHERE status = 'authenticated' ORDER BY created_at DESC
        ''').fetchall()
        return [{
            "session_id": r["session_id"],
            "device_info": r["device_info"] or "Desktop Session",
            "connected_at": r["created_at"],
            "is_restricted": bool(r["is_restricted"]),
            "mask_folders": bool(r["mask_folders"]),
            "disable_profile": bool(r["disable_profile"]),
            "allow_print": bool(r["allow_print"])
        } for r in rows]
    except sqlite3.Error as e:
        print(f"[QR LIST ERROR]: {e}")
        return []
    finally:
        if conn:
            conn.close()


def update_qr_restriction_field_db(session_id, field, bool_val):
    """Updates a specific live restriction toggle for one or all paired desktops."""
    if field not in ['is_restricted', 'mask_folders', 'disable_profile', 'allow_print']:
        return False
    val = 1 if bool_val else 0
    conn = None
    try:
        conn = get_db_connection()
        if session_id == 'all':
            conn.execute(f"UPDATE secure_qr_vault SET {field} = ? WHERE status = 'authenticated'", (val,))
        else:
            conn.execute(f"UPDATE secure_qr_vault SET {field} = ? WHERE session_id = ?", (val, session_id))
        conn.commit()
        return True
    except sqlite3.Error as e:
        print(f"[QR RESTRICTION UPDATE ERROR]: {e}")
        return False
    finally:
        if conn:
            conn.close()


def terminate_qr_session_db(session_id='all'):
    """Terminates one specific desktop session or all active QR sessions."""
    conn = None
    try:
        conn = get_db_connection()
        if session_id == 'all' or not session_id:
            conn.execute("UPDATE secure_qr_vault SET status = 'terminated' WHERE status = 'authenticated'")
        else:
            conn.execute("UPDATE secure_qr_vault SET status = 'terminated' WHERE session_id = ?", (session_id,))
        conn.commit()
    except sqlite3.Error as e:
        print(f"[QR TERMINATE ERROR]: {e}")
    finally:
        if conn:
            conn.close()


# ========================================================================
# ☁️ MULTI-ACCOUNT CLOUD DB OPERATIONS
# ========================================================================
def get_cloud_account_db(account_id):
    conn = None
    try:
        conn = get_db_connection()
        row = conn.execute("SELECT * FROM cloud_accounts WHERE account_id = ?", (account_id,)).fetchone()
        return dict(row) if row else None
    except sqlite3.Error as e:
        print(f"[CLOUD ACCOUNT FETCH ERROR]: {e}")
        return None
    finally:
        if conn:
            conn.close()


def get_first_enabled_cloud_account_db():
    conn = None
    try:
        conn = get_db_connection()
        row = conn.execute("SELECT * FROM cloud_accounts WHERE is_enabled = 1 LIMIT 1").fetchone()
        return dict(row) if row else None
    except sqlite3.Error:
        return None
    finally:
        if conn:
            conn.close()


def get_all_cloud_accounts_db():
    conn = None
    try:
        conn = get_db_connection()
        rows = conn.execute("SELECT * FROM cloud_accounts ORDER BY created_at DESC").fetchall()
        return [dict(r) for r in rows]
    except sqlite3.Error as e:
        print(f"[CLOUD ACCOUNTS LIST ERROR]: {e}")
        return []
    finally:
        if conn:
            conn.close()


def save_or_update_cloud_account_db(provider, email, custom_name, access_token, refresh_token, expires_at):
    conn = None
    try:
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
        return acc_id
    except sqlite3.Error as e:
        print(f"[CLOUD ACCOUNT SAVE ERROR]: {e}")
        return None
    finally:
        if conn:
            conn.close()


def update_cloud_account_tokens_db(account_id, access_token, refresh_token, expires_at, status='valid'):
    conn = None
    try:
        conn = get_db_connection()
        conn.execute('''
            UPDATE cloud_accounts
            SET access_token = ?, refresh_token = ?, expires_at = ?, token_status = ?
            WHERE account_id = ?
        ''', (access_token, refresh_token, expires_at, status, account_id))
        conn.commit()
    except sqlite3.Error as e:
        print(f"[TOKEN UPDATE ERROR]: {e}")
    finally:
        if conn:
            conn.close()


def set_cloud_account_status_db(account_id, status):
    conn = None
    try:
        conn = get_db_connection()
        conn.execute("UPDATE cloud_accounts SET token_status = ? WHERE account_id = ?", (status, account_id))
        conn.commit()
    except sqlite3.Error:
        pass
    finally:
        if conn:
            conn.close()


def modify_cloud_account_db(account_id, action, value=None):
    conn = None
    try:
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
    except sqlite3.Error as e:
        print(f"[CLOUD ACCOUNT MODIFY ERROR]: {e}")
    finally:
        if conn:
            conn.close()


# ========================================================================
# 📂 IMPORTED CLOUD ASSETS & PRINT QUEUE DB OPERATIONS
# ========================================================================
def save_imported_asset_db(cloud_id, name, asset_type, children_tree, provider, account_id, account_name):
    conn = None
    try:
        conn = get_db_connection()
        conn.execute('''
            INSERT OR REPLACE INTO imported_assets 
            (cloud_id, name, type, children_data, session_id, provider, account_id, account_name)
            VALUES (?, ?, ?, ?, 'core_authenticated_user', ?, ?, ?)
        ''', (cloud_id, name, asset_type, json.dumps(children_tree), provider, account_id, account_name))
        conn.commit()
    except sqlite3.Error as e:
        print(f"[ASSET SAVE ERROR]: {e}")
    finally:
        if conn:
            conn.close()


def get_all_imported_assets_db():
    conn = None
    try:
        conn = get_db_connection()
        rows = conn.execute("SELECT * FROM imported_assets").fetchall()
        return [dict(r) for r in rows]
    except sqlite3.Error:
        return []
    finally:
        if conn:
            conn.close()


def get_print_queue_db():
    conn = None
    try:
        conn = get_db_connection()
        rows = conn.execute("SELECT * FROM print_queue ORDER BY added_at DESC").fetchall()
        return [{
            "item_path": r["item_path"], "name": r["name"], "type": "file", "file_type": r["file_type"],
            "size": r["size"], "cloud_id": r["cloud_id"], "account_id": r["account_id"],
            "account_name": r["account_name"], "provider": r["provider"]
        } for r in rows]
    except sqlite3.Error:
        return []
    finally:
        if conn:
            conn.close()


def add_to_print_queue_db(data):
    conn = None
    try:
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
    except sqlite3.Error as e:
        print(f"[PRINT QUEUE ADD ERROR]: {e}")
    finally:
        if conn:
            conn.close()


def remove_from_print_queue_db(item_path):
    conn = None
    try:
        conn = get_db_connection()
        if item_path == 'all':
            conn.execute("DELETE FROM print_queue")
        else:
            conn.execute("DELETE FROM print_queue WHERE item_path = ?", (item_path,))
        conn.commit()
    except sqlite3.Error as e:
        print(f"[PRINT QUEUE REMOVE ERROR]: {e}")
    finally:
        if conn:
            conn.close()


# ========================================================================
# ⚡ REAL-TIME UPLOAD SYNC EVENTS DB OPERATIONS
# ========================================================================
def record_sync_event_db(event_type, filename, folder_path):
    conn = None
    try:
        conn = get_db_connection()
        conn.execute('''
            INSERT INTO vault_sync_events (event_type, filename, folder_path, created_at)
            VALUES (?, ?, ?, ?)
        ''', (event_type, filename, folder_path or 'Root Vault', time.time()))
        conn.commit()
    except sqlite3.Error as e:
        print(f"[SYNC EVENT RECORD ERROR]: {e}")
    finally:
        if conn:
            conn.close()


def get_latest_sync_state_db():
    conn = None
    try:
        conn = get_db_connection()
        ev = conn.execute("SELECT MAX(event_id) as id, filename, folder_path, created_at FROM vault_sync_events").fetchone()
        cnt = conn.execute("SELECT COUNT(*) as c FROM secure_qr_vault WHERE status = 'authenticated'").fetchone()
        latest = None
        if ev and ev["id"]:
            latest = {
                "event_id": ev["id"],
                "filename": ev["filename"],
                "folder_path": ev["folder_path"],
                "created_at": ev["created_at"]
            }
        return latest, (cnt["c"] if cnt else 0)
    except sqlite3.Error:
        return None, 0
    finally:
        if conn:
            conn.close()