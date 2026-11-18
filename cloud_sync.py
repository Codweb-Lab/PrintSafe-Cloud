import os
from db_setup import get_decrypted_config_db


# ========================================================================
# ☁️ PRINTSAFE CLOUD — ENCRYPTED OAUTH CREDENTIAL PROVIDER (cloud_sync.py)
# ========================================================================
class CloudSyncVault:
    """Reads AES-256 encrypted OAuth Client IDs & Secrets from SQLite with .env fallback."""

    def __init__(self, db_path='secure_vault.db'):
        self.db_path = db_path

    @property
    def google_config(self):
        """Returns decrypted Google OAuth Client ID and Client Secret."""
        return {
            'client_id': get_decrypted_config_db('google_client_id') or os.getenv('GOOGLE_CLIENT_ID', ''),
            'client_secret': get_decrypted_config_db('google_client_secret') or os.getenv('GOOGLE_CLIENT_SECRET', ''),
            'redirect_uri': os.getenv('GOOGLE_REDIRECT_URI', '')
        }

    @property
    def onedrive_config(self):
        """Returns decrypted Microsoft OneDrive OAuth Client ID and Client Secret."""
        return {
            'client_id': get_decrypted_config_db('onedrive_client_id') or os.getenv('ONEDRIVE_CLIENT_ID', ''),
            'client_secret': get_decrypted_config_db('onedrive_client_secret') or os.getenv('ONEDRIVE_CLIENT_SECRET', ''),
            'redirect_uri': os.getenv('ONEDRIVE_REDIRECT_URI', '')
        }