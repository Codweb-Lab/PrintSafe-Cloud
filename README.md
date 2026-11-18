# PrintSafe Cloud

**Zero-Trust Multi-Cloud & Remote Print Vault**

PrintSafe Cloud is a high-performance, self-hosted Flask web application that unifies **Google Drive**, **Microsoft OneDrive**, **SSH/SFTP & FTP hosting storage**, and **local encrypted storage** into a single workspace—built for secure document viewing, vector printing, and restricted remote desktop pairing.

---

## Key Features

### User Workspace & Security
- **Decoupled Split Architecture:** Standalone login portal at `/` (`login.html`) that routes authenticated sessions into dynamic, session-bound workspace URLs (`/v/<vault_token>`).
- **Multi-Method Authentication & 2FA:**
  - Email + Password, Email + 6-Digit OTP, 4/6-Digit Quick PIN, and Google OAuth 2.0 Sign-In.
  - Time-based One-Time Password (TOTP) Authenticator App 2FA setup and enforcement.
  - Non-blocking asynchronous SMTP / HTTPS Mail Relay dispatch for sub-100ms login responses.
- **Desktop QR Restricted Pairing (`/scan`):**
  - Scan a desktop QR code from a paired mobile device to authorize a remote workstation in **Restricted Mode**.
  - Live remote controls from mobile: mask folder names (`xxxxx`), lock profile/cloud menus, toggle vector printing permissions, or remotely terminate desktop sessions in real time.
- **Unified Multi-Cloud & Hosting Explorer:**
  - Link multiple Google Drive and Microsoft OneDrive accounts simultaneously; browse directories and selectively mount folders into the vault.
  - Connect remote hosting servers via **SSH/SFTP** or **FTP** with encrypted credential storage.
  - Integrated PDF & image previewer with vector print output and a **"To Be Printed"** wishlist queue.
- **Adaptive Design System:** Instant Light/Dark/System theme switching across four UI presets (**Glass Bento**, **Microsoft Fluent**, **IBM Carbon**, and **Cyber Neon**) powered by a shared stylesheet (`vault_core.css`).

### Admin Console (`/admin`)
- **Isolated Secrets Vault (`admin_vault.db`):** AES-256 encrypted storage for SMTP credentials, cPanel HTTPS Mail Relay secrets, and OAuth client keys—completely separated from the main SQLite (WAL mode) user database.
- **Multi-Channel Broadcast & Scheduling Engine:**
  - Send instant or scheduled announcements via **In-App Push Notifications** and **Email**.
  - Interactive Date/Time picker UI with background scheduler worker and custom HTML email template engine (`{{otp_code}}`, `{{user_name}}`, `{{logo_url}}`).
- **Platform Governance:** Live feature flags (toggle registration, Google OAuth, SFTP/FTP hosting, or print queue), multi-profile SMTP gateway switcher, and user quota controls.

---

## Tech Stack
- **Backend:** Python 3.11+, Flask 3.1, SQLite (WAL Mode), Cryptography (AES-256 / Fernet), PyOTP, Paramiko
- **Frontend:** Modular Jinja2 Templates, Shared CSS Design Tokens (`vault_core.css`), Vanilla JavaScript, PDF.js, HTML5-QRCode, RemixIcon
- **Cloud & Mail Integrations:** Google Drive API v3, Microsoft Graph (OneDrive), SMTP SSL/TLS & HTTPS Mail Relay

---

## Project Structure

```text
printsafe-cloud/
├── app.py                     # Main Flask application entry point
├── db_setup.py                # SQLite (WAL) schema & session/sync state helpers
├── admin_db.py                # Isolated AES-256 encrypted admin secrets vault
├── cloud_sync.py              # Multi-account Google Drive, OneDrive & SFTP/FTP engine
├── totp_2fa.py                # TOTP 2FA secret & QR code generator
├── routes/
│   ├── auth_routes.py         # Split routing (/ & /v/<token>), async OTP, 2FA & OAuth
│   └── admin/                 # Admin console, SMTP profiles, broadcasts & templates
├── templates/
│   ├── login.html             # Standalone authentication & QR gate
│   ├── index.html             # Authenticated workspace shell
│   ├── scanner.html           # Mobile QR pairing scanner
│   └── partials/              # Modular sidebar, header, auth card, modals & footer
├── static/
│   ├── css/vault_core.css     # Unified theme variables & preset styles
│   └── js/                    # Modular state, auth, explorer, preview & cloud_admin
├── .gitignore                 # Blocks *.db, WAL files, encryption keys & local uploads
└── requirements.txt           # Pinned Python dependencies