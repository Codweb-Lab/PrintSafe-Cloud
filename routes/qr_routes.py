import io, base64, time, qrcode
from flask import Blueprint, make_response, request, jsonify, session
from db_setup import (
    create_qr_session_db, get_qr_session_db, approve_qr_session_db,
    list_authenticated_qr_sessions_db, update_qr_restriction_field_db,
    terminate_qr_session_db, get_latest_sync_state_db
)

qr_bp = Blueprint('qr', __name__)

@qr_bp.route('/generate-qr-session', methods=['GET'])
def generate_qr_session():
    ua = request.headers.get('User-Agent', 'Desktop Browser')
    device_label = "Windows PC" if "Windows" in ua else ("Mac" if "Mac" in ua else "Desktop")
    try:
        session_id = create_qr_session_db(device_label)
    except Exception:
        return jsonify({"error": "Database error"}), 500

    qr = qrcode.QRCode(version=1, box_size=10, border=4)
    qr.add_data(session_id)
    qr.make(fit=True)
    img = qr.make_image(fill_color="#0f172a", back_color="white")
    buffered = io.BytesIO()
    img.save(buffered, format="PNG")
    qr_base64 = base64.b64encode(buffered.getvalue()).decode('utf-8')
    return jsonify({"session_id": session_id, "qr_image": f"data:image/png;base64,{qr_base64}"})

@qr_bp.route('/verify-private-scan/<session_id>', methods=['GET', 'POST'])
def verify_private_scan(session_id):
    clean_sid = session_id.split('?')[0].strip()
    row = get_qr_session_db(clean_sid)
    if not row:
        return jsonify({"success": False, "error": "Invalid or Terminated Session!"}), 404

    if row['status'] == "pending" and (time.time() - row['created_at'] > 25):
        return jsonify({"success": False, "error": "QR Code Expired!"}), 404

    if request.method == 'POST':
        approve_qr_session_db(clean_sid)
        return jsonify({"success": True, "message": "Desktop Authenticated in Restricted Mode"}), 200

    if row['status'] == "authenticated":
        session.permanent = True
        session['is_authenticated'] = True
        session['session_id'] = clean_sid
        session['login_type'] = 'qr_restricted'
        latest_event, _ = get_latest_sync_state_db()
        resp = make_response(jsonify({
            "success": True,
            "status": "authenticated",
            "restrictions": {
                "is_restricted": bool(row['is_restricted']),
                "mask_folders": bool(row['mask_folders']),
                "disable_profile": bool(row['disable_profile']),
                "allow_print": bool(row['allow_print'])
            },
            "latest_event": latest_event
        }))
    elif row['status'] == "terminated":
        session.clear()
        resp = make_response(jsonify({"success": False, "status": "terminated"}))
    else:
        resp = make_response(jsonify({"success": False, "status": row['status']}))

    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
    return resp

@qr_bp.route('/api/connected-sessions', methods=['GET'])
def get_connected_sessions():
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized"}), 403
    sessions = list_authenticated_qr_sessions_db()
    return jsonify({"count": len(sessions), "sessions": sessions})

@qr_bp.route('/api/session-restrictions/update', methods=['POST'])
def update_session_restrictions():
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized"}), 403
    data = request.get_json(silent=True) or {}
    ok = update_qr_restriction_field_db(data.get('session_id'), data.get('field'), data.get('value'))
    if not ok:
        return jsonify({"success": False, "error": "Invalid field"}), 400
    return jsonify({"success": True})

@qr_bp.route('/terminate-desktop-session', methods=['POST'])
def terminate_desktop_session():
    data = request.get_json(silent=True) or {}
    sid = data.get('session_id', 'all')
    if sid != 'all' and sid:
        sid = sid.split('?')[0].strip()
    terminate_qr_session_db(sid)
    return jsonify({"success": True, "message": "Connected desktop session(s) logged out"}), 200