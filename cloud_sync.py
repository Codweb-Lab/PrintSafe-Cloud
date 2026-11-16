# ========================================================================
# ☁️ CLOUD SYNC VAULT CORE: For multi-service drive integration handshakes
# ========================================================================
import requests
from requests_oauthlib import OAuth2Session
import time
import json
import sqlite3

# Define Core API Endpoints for Google Drive and OneDrive
GOOGLE_DRIVE_API_BASE = "https://www.googleapis.com/drive/v3"
ONEDRIVE_API_BASE = "https://graph.microsoft.com/v1.0"

class CloudSyncVault:
    """Blueprint for securely integrating external cloud storage APIs."""
    
    def __init__(self, db_path, google_config=None, onedrive_config=None):
        self.DB_PATH = db_path
        
        # 🎯 GOOGLE CONFIGURATION
        self.google_config = google_config or {}
        
        # 🎯 ONEDRIVE CONFIGURATION
        self.onedrive_config = onedrive_config or {}

        # 🎯 THE AUTO-CREATE FIX: Force creation of the cloud token vault table on boot immediately
        try:
            conn = sqlite3.connect(self.DB_PATH, timeout=20)
            cursor = conn.cursor()
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS cloud_tokens_vault (
                    session_id TEXT,
                    service TEXT,
                    access_token TEXT,
                    refresh_token TEXT,
                    expires_at REAL,
                    user_email TEXT,
                    PRIMARY KEY (session_id, service)
                )
            ''')
            conn.commit()
            conn.close()
            print("[CLOUD SYNC BOOTSTRAP]: Verified and secured cloud_tokens_vault table successfully.")
        except Exception as table_err:
            print(f"[CLOUD SYNC BOOTSTRAP CRITICAL ERROR]: {str(table_err)}")
    
    # ========================================================================
    # 🎯 STEP 1: AUTHENTICATION GATEWAYS (How we get user permission)
    # ========================================================================
    def get_google_auth_url(self):
        """Generates the secure authorization pipeline URL for Google Drive."""
        try:
            google = OAuth2Session(self.google_config['client_id'], 
                                   scope=self.google_config['scopes'], 
                                   redirect_uri=self.google_config['redirect_uri'])
            
            # Use offline access and consent prompt to ensure we get a refresh token
            authorization_url, state = google.authorization_url('https://accounts.google.com/o/oauth2/v2/auth', 
                                                               access_type="offline", 
                                                               prompt="consent")
            return authorization_url, state
        except Exception as e:
            print(f"[GOOGLE AUTH URL GENERATION CRITICAL ERROR]: {str(e)}")
            return None, None

    def get_onedrive_auth_url(self):
        """Generates the secure authorization pipeline URL for OneDrive."""
        try:
            onedrive = OAuth2Session(self.onedrive_config['client_id'], 
                                     scope=self.onedrive_config['scopes'], 
                                     redirect_uri=self.onedrive_config['redirect_uri'])
            
            authorization_url, state = onedrive.authorization_url('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
            return authorization_url, state
        except Exception as e:
            print(f"[ONEDRIVE AUTH URL GENERATION CRITICAL ERROR]: {str(e)}")
            return None, None

    # ========================================================================
    # 🎯 STEP 2: TOKEN MANAGERS (Saving and refreshing OAuth sessions safely)
    # ========================================================================
    def save_cloud_tokens(self, session_id, service, token_data, email=""):
        """Saves or updates OAuth credentials cleanly into the database register."""
        try:
            current_time = time.time()
            # Calculate absolute expiry time based on seconds remaining (expires_in default is usually 3600)
            expires_at = current_time + token_data.get('expires_in', 3600)
            
            access_token = token_data.get('access_token')
            # Fallback to keep existing refresh token if provider doesn't resend it on updates
            refresh_token = token_data.get('refresh_token')

            conn = sqlite3.connect(self.DB_PATH, timeout=20)
            cursor = conn.cursor()
            
            if not refresh_token:
                cursor.execute("SELECT refresh_token FROM cloud_tokens_vault WHERE session_id = ? AND service = ?", (session_id, service))
                row = cursor.fetchone()
                if row: refresh_token = row[0]

            cursor.execute('''
                INSERT OR REPLACE INTO cloud_tokens_vault 
                (session_id, service, access_token, refresh_token, expires_at, user_email) 
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (session_id, service, access_token, refresh_token, expires_at, email))
            
            conn.commit()
            conn.close()
            return True
        except Exception as e:
            print(f"[TOKEN SAVE PIPELINE CRASH]: {str(e)}")
            return False

    def get_valid_access_token(self, session_id, service):
        """Retrieves a secure functional token, auto-refreshing it if close to expiry."""
        try:
            conn = sqlite3.connect(self.DB_PATH, timeout=20)
            cursor = conn.cursor()
            cursor.execute("SELECT access_token, refresh_token, expires_at FROM cloud_tokens_vault WHERE session_id = ? AND service = ?", (session_id, service))
            row = cursor.fetchone()
            conn.close()

            if not row: return None

            access_token, refresh_token, expires_at = row[0], row[1], row[2]

            # 🧠 AUTOPILOT REFRESH: If token expires within 5 minutes, force update it silently
            if expires_at - time.time() < 300:
                print(f"[CLOUD SYNC MONITOR]: Token near expiry for {service}. Regenerating token keys...")
                
                if service == 'google':
                    payload = {
                        'client_id': self.google_config['client_id'],
                        'client_secret': self.google_config['client_secret'],
                        'refresh_token': refresh_token,
                        'grant_type': 'refresh_token'
                    }
                    response = requests.post('https://oauth2.googleapis.com/token', data=payload)
                else: # OneDrive integration branch
                    payload = {
                        'client_id': self.onedrive_config['client_id'],
                        'client_secret': self.onedrive_config['client_secret'],
                        'refresh_token': refresh_token,
                        'grant_type': 'refresh_token'
                    }
                    response = requests.post('https://login.microsoftonline.com/common/oauth2/v2.0/token', data=payload)

                if response.status_ok or response.status_code == 200:
                    new_token_data = response.json()
                    self.save_cloud_tokens(session_id, service, new_token_data)
                    return new_token_data.get('access_token')
                else:
                    print(f"[REFRESH ATTEMPT FAILURE]: Provider rejected token cycle.")
                    return None

            return access_token
        except Exception as e:
            print(f"[TOKEN CHECKER ERROR]: {str(e)}")
            return None
    # Future Methods (We will build these in the next step):
    # def handle_google_callback(self, authorization_response, state, user_id): ...
    # def handle_onedrive_callback(self, authorization_response, state, user_id): ...
    
    # ========================================================================
    # 🎯 STEP 3: CLOUD FILE FETCHERS (Retrieving drive contents via REST APIs)
    # ========================================================================
    # ========================================================================
    # 🎯 UPGRADED FETCHERS: Now accepts dynamic folder_id for deep navigation
    # ========================================================================
    def fetch_google_drive_files(self, session_id, folder_id='root'):
        """Fetches files from Google Drive within a specific parent folder ID."""
        access_token = self.get_valid_access_token(session_id, 'google')
        if not access_token: return None

        headers = {"Authorization": f"Bearer {access_token}"}
        # 🧠 THE KEY CHANGE: Filter by specific parent folder ID dynamically
        query = f"'{folder_id}' in parents and trashed=false"
        url = f"{GOOGLE_DRIVE_API_BASE}/files?q={query}&fields=files(id,name,mimeType,size)"
        
        try:
            response = requests.get(url, headers=headers, timeout=15)
            if response.status_code == 200:
                google_files = response.json().get('files', [])
                mapped_tree = []
                
                for item in google_files:
                    is_folder = item.get('mimeType') == 'application/vnd.google-apps.folder'
                    mapped_tree.append({
                        "name": item.get('name'),
                        "type": "folder" if is_folder else "file",
                        "file_type": "google_doc" if is_folder else "cloud_file",
                        "size": int(item.get('size', 0)) if item.get('size') else 0,
                        "cloud_id": item.get('id') # Crucial token string passed to frontend
                    })
                return sorted(mapped_tree, key=lambda x: (x['type'] != 'folder', x['name'].lower()))
            return []
        except Exception as e:
            print(f"[GOOGLE DRIVE DEEP FETCH CRASH]: {str(e)}")
            return []

    def fetch_onedrive_files(self, session_id, folder_id='root'):
        """Fetches items from Microsoft OneDrive inside a specific parent item ID."""
        access_token = self.get_valid_access_token(session_id, 'onedrive')
        if not access_token: return None

        headers = {"Authorization": f"Bearer {access_token}"}
        # 🧠 ONEDRIVE MECHANICS: Route smoothly between root node and explicit item IDs
        if folder_id == 'root':
            url = f"{ONEDRIVE_API_BASE}/me/drive/root/children"
        else:
            url = f"{ONEDRIVE_API_BASE}/me/drive/items/{folder_id}/children"
        
        try:
            response = requests.get(url, headers=headers, timeout=15)
            if response.status_code == 200:
                onedrive_files = response.json().get('value', [])
                mapped_tree = []
                
                for item in onedrive_files:
                    is_folder = 'folder' in item
                    mapped_tree.append({
                        "name": item.get('name'),
                        "type": "folder" if is_folder else "file",
                        "file_type": "onedrive_doc" if is_folder else "cloud_file",
                        "size": item.get('size', 0),
                        "cloud_id": item.get('id')
                    })
                return sorted(mapped_tree, key=lambda x: (x['type'] != 'folder', x['name'].lower()))
            return []
        except Exception as e:
            print(f"[ONEDRIVE DEEP FETCH CRASH]: {str(e)}")
            return []


# Example: How to instantiate the vault on bootup (add this to db_setup.py or app_2.py)
# cloud_vault = CloudSyncVault(DB_PATH)