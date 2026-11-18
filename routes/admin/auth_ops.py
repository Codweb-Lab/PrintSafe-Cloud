from flask import Blueprint, redirect, redirect, render_template, request, jsonify, session
from werkzeug.security import check_password_hash
from db_setup import get_stored_password_hash

admin_auth_bp = Blueprint('admin_auth', __name__)


def is_admin_authenticated():
    return bool(session.get('admin_authenticated') is True)


@admin_auth_bp.route('/admin', methods=['GET'])
@admin_auth_bp.route('/admin/', methods=['GET'])
def admin_portal():
    return render_template('admin.html', is_admin=is_admin_authenticated())


@admin_auth_bp.route('/api/admin/login', methods=['POST'])
def admin_login():
    data = request.get_json(silent=True) or {}
    secret = (data.get('password') or '').strip()
    stored_hash = get_stored_password_hash()

    if secret and stored_hash and check_password_hash(stored_hash, secret):
        session.permanent = True
        session['admin_authenticated'] = True
        return jsonify({"success": True})

    return jsonify({"success": False, "error": "Invalid Administrator Secret Key!"}), 401


@admin_auth_bp.route('/api/admin/logout', methods=['POST', 'GET'])
@admin_auth_bp.route('/admin/logout', methods=['GET'])
def admin_logout_api():
    session.pop('admin_authenticated', None)
    session.modified = True
    if request.method == 'POST' or request.is_json:
        return jsonify({"success": True})
    return redirect('/admin')