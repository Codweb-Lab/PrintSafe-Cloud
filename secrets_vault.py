import os
import time
import base64
import hashlib
import sqlite3
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

SECRETS_DB_PATH = os.path.join(os.getcwd(), "vault_secrets.db")
MASTER_KEY_FILE = os.path.join(os.getcwd(), ".vault_master.key")


def _get_or_create_master_key() -> bytes:
    """Loads or generates a unique 32-byte cryptographically random master key on disk."""
    if os.path.exists(MASTER_KEY_FILE):
        with open(MASTER_KEY_FILE, "rb") as f:
            raw = f.read().strip()
            if len(raw) >= 32:
                return raw
    raw = os.urandom(32)
    with open(MASTER_KEY_FILE, "wb") as f:
        f.write(raw)
    try:
        os.chmod(MASTER_KEY_FILE, 0o600)
    except OSError:
        pass
    return raw


def _get_cipher() -> Fernet:
    """Derives an AES-256 Fernet cipher using PBKDF2-HMAC-SHA256."""
    master = _get_or_create_master_key()
    salt = hashlib.sha256(b"PrintSafe_ZeroTrust_Secrets_Salt_v2").digest()[:16]
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=390000,
    )
    key = base64.urlsafe_b64encode(kdf.derive(master))
    return Fernet(key)


def get_secrets_conn():
    conn = sqlite3.connect(SECRETS_DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn


def init_secrets_vault():
    """Initializes the isolated secrets database completely separate from user data."""
    conn = get_secrets_conn()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS encrypted_secrets (
                secret_key TEXT PRIMARY KEY,
                key_hash TEXT NOT NULL,
                cipher_value TEXT NOT NULL,
                updated_at REAL NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS hashed_credentials (
                cred_key TEXT PRIMARY KEY,
                hash_value TEXT NOT NULL,
                updated_at REAL NOT NULL
            )
        """)
        conn.commit()
    finally:
        conn.close()


def set_vault_secret(secret_key: str, plain_value: str):
    """Encrypts sensitive values using AES-256 and stores them in isolated vault_secrets.db."""
    init_secrets_vault()
    clean_key = (secret_key or "").strip()
    if not clean_key:
        return

    conn = get_secrets_conn()
    try:
        if not plain_value:
            conn.execute("DELETE FROM encrypted_secrets WHERE secret_key = ?", (clean_key,))
            conn.commit()
            return

        cipher = _get_cipher()
        token = cipher.encrypt(plain_value.encode("utf-8")).decode("utf-8")
        key_hash = hashlib.sha256(clean_key.encode("utf-8")).hexdigest()

        conn.execute(
            """
            INSERT INTO encrypted_secrets (secret_key, key_hash, cipher_value, updated_at)
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


def get_vault_secret(secret_key: str, default: str = "") -> str:
    """Decrypts and returns a secret from vault_secrets.db."""
    init_secrets_vault()
    clean_key = (secret_key or "").strip()
    conn = get_secrets_conn()
    try:
        row = conn.execute(
            "SELECT cipher_value FROM encrypted_secrets WHERE secret_key = ?",
            (clean_key,)
        ).fetchone()
        if not row or not row["cipher_value"]:
            return default
        cipher = _get_cipher()
        return cipher.decrypt(row["cipher_value"].encode("utf-8")).decode("utf-8")
    except Exception:
        return default
    finally:
        conn.close()


def set_vault_hash(cred_key: str, raw_secret: str):
    """Stores a one-way salted PBKDF2-SHA256 hash (for API keys/admin secrets)."""
    init_secrets_vault()
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", raw_secret.encode("utf-8"), salt, 260000)
    stored = f"{salt.hex()}:{dk.hex()}"
    conn = get_secrets_conn()
    try:
        conn.execute(
            """
            INSERT INTO hashed_credentials (cred_key, hash_value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(cred_key) DO UPDATE SET
                hash_value = excluded.hash_value,
                updated_at = excluded.updated_at
            """,
            (cred_key, stored, time.time())
        )
        conn.commit()
    finally:
        conn.close()


def verify_vault_hash(cred_key: str, candidate_secret: str) -> bool:
    """Verifies a candidate secret against its stored PBKDF2-SHA256 hash."""
    init_secrets_vault()
    conn = get_secrets_conn()
    try:
        row = conn.execute(
            "SELECT hash_value FROM hashed_credentials WHERE cred_key = ?",
            (cred_key,)
        ).fetchone()
        if not row:
            return False
        salt_hex, dk_hex = row["hash_value"].split(":", 1)
        dk = hashlib.pbkdf2_hmac("sha256", candidate_secret.encode("utf-8"), bytes.fromhex(salt_hex), 260000)
        return dk.hex() == dk_hex
    except Exception:
        return False
    finally:
        conn.close()