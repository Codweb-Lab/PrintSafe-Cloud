import os
import json
import time
import uuid
import base64
import hashlib
import sqlite3
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from db_setup import get_system_config_db, set_system_config_db, get_decrypted_config_db

ADMIN_DB_PATH = os.path.join(os.getcwd(), "admin_vault.db")
ADMIN_KEY_FILE = os.path.join(os.getcwd(), ".admin_vault.key")


def _get_or_create_master_key() -> bytes:
    if os.path.exists(ADMIN_KEY_FILE):
        with open(ADMIN_KEY_FILE, "rb") as f:
            raw = f.read().strip()
            if len(raw) >= 32:
                return raw
    raw = os.urandom(32)
    with open(ADMIN_KEY_FILE, "wb") as f:
        f.write(raw)
    try:
        os.chmod(ADMIN_KEY_FILE, 0o600)
    except OSError:
        pass
    return raw


def _get_cipher() -> Fernet:
    master = _get_or_create_master_key()
    salt = hashlib.sha256(b"PrintSafe_Admin_Isolated_Vault_Salt_v3").digest()[:16]
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=390000,
    )
    return Fernet(base64.urlsafe_b64encode(kdf.derive(master)))


def get_admin_db_conn():
    conn = sqlite3.connect(ADMIN_DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn


def init_admin_db():
    """Creates isolated admin_vault.db completely separate from user database."""
    conn = get_admin_db_conn()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS admin_encrypted_secrets (
                secret_key TEXT PRIMARY KEY,
                key_hash TEXT NOT NULL,
                cipher_value TEXT NOT NULL,
                updated_at REAL NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS admin_settings (
                setting_key TEXT PRIMARY KEY,
                setting_value TEXT NOT NULL,
                updated_at REAL NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS smtp_gateway_profiles (
                profile_id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                provider TEXT NOT NULL,
                smtp_host TEXT NOT NULL,
                smtp_port TEXT NOT NULL,
                smtp_user TEXT NOT NULL,
                smtp_from_name TEXT NOT NULL,
                smtp_from_email TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 0,
                updated_at REAL NOT NULL
            )
        """)
        conn.commit()
    finally:
        conn.close()


def set_admin_secret(secret_key: str, plain_value: str):
    init_admin_db()
    clean_key = (secret_key or "").strip()
    if not clean_key:
        return
    conn = get_admin_db_conn()
    try:
        if not plain_value:
            conn.execute("DELETE FROM admin_encrypted_secrets WHERE secret_key = ?", (clean_key,))
            conn.commit()
            return
        token = _get_cipher().encrypt(plain_value.encode("utf-8")).decode("utf-8")
        key_hash = hashlib.sha256(clean_key.encode("utf-8")).hexdigest()
        conn.execute(
            """
            INSERT INTO admin_encrypted_secrets (secret_key, key_hash, cipher_value, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(secret_key) DO UPDATE SET
                cipher_value = excluded.cipher_value,
                updated_at = excluded.updated_at
            """,
            (clean_key, key_hash, token, time.time())
        )
        conn.commit()
    finally:
        conn.close()


def get_admin_secret(secret_key: str, default: str = "") -> str:
    init_admin_db()
    conn = get_admin_db_conn()
    try:
        row = conn.execute(
            "SELECT cipher_value FROM admin_encrypted_secrets WHERE secret_key = ?",
            ((secret_key or "").strip(),)
        ).fetchone()
        if not row or not row["cipher_value"]:
            return default
        return _get_cipher().decrypt(row["cipher_value"].encode("utf-8")).decode("utf-8")
    except Exception:
        return default
    finally:
        conn.close()


def set_admin_setting(key: str, value: str):
    init_admin_db()
    conn = get_admin_db_conn()
    try:
        conn.execute(
            """
            INSERT INTO admin_settings (setting_key, setting_value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(setting_key) DO UPDATE SET
                setting_value = excluded.setting_value,
                updated_at = excluded.updated_at
            """,
            (key.strip(), str(value), time.time())
        )
        conn.commit()
    finally:
        conn.close()


def get_admin_setting(key: str, default: str = "") -> str:
    init_admin_db()
    conn = get_admin_db_conn()
    try:
        row = conn.execute(
            "SELECT setting_value FROM admin_settings WHERE setting_key = ?",
            (key.strip(),)
        ).fetchone()
        return row["setting_value"] if row else default
    finally:
        conn.close()


def list_smtp_profiles_db() -> list:
    init_admin_db()
    conn = get_admin_db_conn()
    try:
        rows = conn.execute(
            "SELECT * FROM smtp_gateway_profiles ORDER BY is_active DESC, updated_at DESC"
        ).fetchall()
        profiles = [dict(r) for r in rows]

        # Auto-migrate from legacy JSON config if table is empty
        if not profiles:
            legacy_raw = get_system_config_db("smtp_profiles_json", "")
            if legacy_raw:
                try:
                    for item in json.loads(legacy_raw):
                        pid = item.get("id") or f"smtp_{uuid.uuid4().hex[:8]}"
                        old_pass = get_decrypted_config_db(f"smtp_prof_pass_{pid}") or get_decrypted_config_db("smtp_pass")
                        if old_pass:
                            set_admin_secret(f"smtp_prof_pass_{pid}", old_pass)
                        conn.execute(
                            """
                            INSERT OR REPLACE INTO smtp_gateway_profiles
                            (profile_id, label, provider, smtp_host, smtp_port, smtp_user, smtp_from_name, smtp_from_email, is_active, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            """,
                            (
                                pid,
                                item.get("label", "SMTP Gateway"),
                                item.get("provider", "custom"),
                                item.get("smtp_host", ""),
                                str(item.get("smtp_port", "465")),
                                item.get("smtp_user", ""),
                                item.get("smtp_from_name", "PrintSafe Cloud"),
                                item.get("smtp_from_email", ""),
                                1 if item.get("is_active") else 0,
                                time.time()
                            )
                        )
                    conn.commit()
                    rows = conn.execute(
                        "SELECT * FROM smtp_gateway_profiles ORDER BY is_active DESC, updated_at DESC"
                    ).fetchall()
                    profiles = [dict(r) for r in rows]
                except Exception:
                    pass

        for p in profiles:
            p["id"] = p["profile_id"]
            p["is_active"] = bool(p["is_active"])
            p["has_pass"] = bool(get_admin_secret(f"smtp_prof_pass_{p['profile_id']}"))
        return profiles
    finally:
        conn.close()


def sync_active_smtp_gateway():
    """Syncs the single active SMTP gateway into runtime config keys used by auth_routes.py."""
    profiles = list_smtp_profiles_db()
    active = next((p for p in profiles if p["is_active"]), None)
    if active:
        set_system_config_db("smtp_host", active["smtp_host"])
        set_system_config_db("smtp_port", active["smtp_port"])
        set_system_config_db("smtp_user", active["smtp_user"])
        set_system_config_db("smtp_from_name", active["smtp_from_name"])
        set_system_config_db("smtp_from_email", active["smtp_from_email"])
        pw = get_admin_secret(f"smtp_prof_pass_{active['profile_id']}")
        set_admin_secret("active_smtp_pass", pw)
    else:
        set_system_config_db("smtp_host", "")
        set_system_config_db("smtp_user", "")
        set_admin_secret("active_smtp_pass", "")