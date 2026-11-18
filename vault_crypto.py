import os
import base64
import hashlib
from cryptography.fernet import Fernet, InvalidToken
from db_setup import get_system_config_db, set_system_config_db

# Magic header to distinguish AES-256 encrypted files from legacy plaintext files
ENC_MAGIC = b"PSC_AES256_V1::"


# ========================================================================
# 🔐 KEY DERIVATION & CIPHER ENGINE
# ========================================================================
def get_vault_fernet():
    """Derives a deterministic 256-bit Fernet key using PBKDF2-HMAC-SHA256."""
    try:
        salt_b64 = get_system_config_db("vault_crypto_salt")
        if not salt_b64:
            salt = os.urandom(16)
            salt_b64 = base64.urlsafe_b64encode(salt).decode("utf-8")
            set_system_config_db("vault_crypto_salt", salt_b64)
        else:
            salt = base64.urlsafe_b64decode(salt_b64.encode("utf-8"))

        secret_seed = (
            get_system_config_db("master_password")
            or os.getenv("FLASK_SECRET_KEY", "printsafe_default_enterprise_key")
        ).encode("utf-8")

        dk = hashlib.pbkdf2_hmac("sha256", secret_seed, salt, 200_000, dklen=32)
        fernet_key = base64.urlsafe_b64encode(dk)
        return Fernet(fernet_key)
    except Exception as e:
        print(f"[CRYPTO KEY DERIVATION ERROR]: {e}")
        raise


# ========================================================================
# 🔒 ENCRYPT / DECRYPT BYTE STREAM HELPERS
# ========================================================================
def encrypt_bytes(raw_bytes: bytes) -> bytes:
    """Encrypts raw file bytes using AES-256 (Fernet) and prepends magic header."""
    if not raw_bytes:
        return raw_bytes
    if raw_bytes.startswith(ENC_MAGIC):
        return raw_bytes

    try:
        cipher = get_vault_fernet()
        return ENC_MAGIC + cipher.encrypt(raw_bytes)
    except Exception as e:
        print(f"[FILE ENCRYPTION ERROR]: {e}")
        raise


def decrypt_bytes(stored_bytes: bytes) -> bytes:
    """Decrypts AES-256 encrypted bytes in memory; passes legacy unencrypted files safely."""
    if not stored_bytes:
        return stored_bytes
    if not stored_bytes.startswith(ENC_MAGIC):
        return stored_bytes  # Backward compatibility for unencrypted legacy files

    try:
        cipher = get_vault_fernet()
        encrypted_payload = stored_bytes[len(ENC_MAGIC):]
        return cipher.decrypt(encrypted_payload)
    except InvalidToken:
        print("[FILE DECRYPTION ERROR]: Invalid decryption key or corrupted ciphertext.")
        raise ValueError("Decryption failed: Invalid vault key or corrupted file.")
    except Exception as e:
        print(f"[FILE DECRYPTION ERROR]: {e}")
        raise