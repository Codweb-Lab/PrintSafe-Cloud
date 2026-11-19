import secrets
from flask import Blueprint, redirect, render_template, request, jsonify, session, url_for
from werkzeug.security import check_password_hash
from db_setup import get_stored_password_hash

admin_auth_bp = Blueprint('admin_auth', __name__)


def is_admin_authenticated():
    return bool(session.get('admin_authenticated') is True)


def _ensure_admin_route_token() -> str:
    tok = session.get('admin_route_token')
    if not tok:
        tok = secrets.token_hex(8)
        session['admin_route_token'] = tok
    return tok


@admin_auth_bp.route('/admin', methods=['GET'])
@admin_auth_bp.route('/admin/', methods=['GET'])
def admin_portal():
    if is_admin_authenticated():
        tok = _ensure_admin_route_token()
        return redirect(url_for('.admin_console_workspace', admin_token=tok))
    return render_template('admin_login.html')


@admin_auth_bp.route('/admin/console/<admin_token>', methods=['GET'])
def admin_console_workspace(admin_token: str):
    if not is_admin_authenticated():
        return redirect(url_for('.admin_portal'))
    expected_tok = _ensure_admin_route_token()
    if admin_token != expected_tok:
        return redirect(url_for('.admin_console_workspace', admin_token=expected_tok))
    return render_template('admin.html', is_admin=True)


@admin_auth_bp.route('/api/admin/login', methods=['POST'])
def admin_login():
    data = request.get_json(silent=True) or {}
    secret = (data.get('password') or data.get('secret_key') or '').strip()
    stored_hash = get_stored_password_hash()

    if secret and stored_hash and check_password_hash(stored_hash, secret):
        session.permanent = True
        session['admin_authenticated'] = True
        tok = _ensure_admin_route_token()
        session.modified = True
        return jsonify({
            "success": True,
            "redirect": url_for('.admin_console_workspace', admin_token=tok)
        })

    return jsonify({"success": False, "error": "Invalid Administrator Secret Key!"}), 401


@admin_auth_bp.route('/api/admin/logout', methods=['POST', 'GET'])
@admin_auth_bp.route('/admin/logout', methods=['GET'])
def admin_logout_api():
    session.pop('admin_authenticated', None)
    session.pop('admin_route_token', None)
    session.modified = True
    if request.method == 'POST' or request.is_json:
        return jsonify({"success": True, "redirect": "/admin"})
    return redirect('/admin')