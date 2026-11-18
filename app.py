import os
import requests
from flask import Flask
from dotenv import load_dotenv
from db_setup import init_db

if not hasattr(requests.Response, 'status_ok'):
    requests.Response.status_ok = property(lambda self: self.ok)

os.environ['OAUTHLIB_INSECURE_TRANSPORT'] = '1'
load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv('FLASK_SECRET_KEY', 'secure_vault_super_secret_key')
app.config['SESSION_COOKIE_SECURE'] = False
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'

# Initialize & upgrade SQLite schema
init_db()


@app.context_processor
def inject_app_meta():
    return {
        "app_version": "v2.2.0",
        "app_name": "PrintSafe Cloud"
    }


# Register ALL Modular Blueprints (including Admin Blueprint)
from routes.auth_routes import auth_bp
from routes.qr_routes import qr_bp
from routes.vault_routes import vault_bp
from routes.cloud_routes import cloud_bp
from routes.admin_routes import admin_bp

app.register_blueprint(auth_bp)
app.register_blueprint(qr_bp)
app.register_blueprint(vault_bp)
app.register_blueprint(cloud_bp)
app.register_blueprint(admin_bp)

if __name__ == '__main__':
    # app.run(host='0.0.0.0', port=8080, debug=True, threaded=True)
    app.run(host='0.0.0.0', port=8080, debug=True, threaded=True, ssl_context='adhoc')