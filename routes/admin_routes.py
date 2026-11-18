from flask import Blueprint
from routes.admin import register_admin_modules

admin_bp = Blueprint('admin', __name__)
register_admin_modules(admin_bp)