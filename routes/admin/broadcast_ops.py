import os
import time
import uuid
import threading
from datetime import datetime
from flask import Blueprint, request, jsonify
from db_setup import get_db_connection, push_notification_db
from admin_db import get_admin_db_conn, init_admin_db
from routes.admin.auth_ops import is_admin_authenticated

admin_bc_bp = Blueprint('admin_broadcast', __name__)
_scheduler_started_pid = None
_scheduler_lock = threading.Lock()


def _ensure_broadcast_table():
    init_admin_db()
    conn = get_admin_db_conn()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS admin_broadcasts (
                broadcast_id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                template_id TEXT NOT NULL DEFAULT '',
                send_push INTEGER NOT NULL DEFAULT 1,
                send_email INTEGER NOT NULL DEFAULT 1,
                scheduled_for REAL NOT NULL,
                status TEXT NOT NULL DEFAULT 'scheduled',
                recipient_count INTEGER NOT NULL DEFAULT 0,
                created_at REAL NOT NULL,
                sent_at REAL DEFAULT 0
            )
        """)
        try:
            conn.execute("ALTER TABLE admin_broadcasts ADD COLUMN template_id TEXT NOT NULL DEFAULT ''")
        except Exception:
            pass
        conn.commit()
    finally:
        conn.close()


def _dispatch_broadcast_now(
    broadcast_id: str,
    title: str,
    message: str,
    send_push: bool,
    send_email: bool,
    template_id: str = ""
):
    user_conn = get_db_connection()
    try:
        users = user_conn.execute("SELECT user_id, full_name, email FROM users").fetchall()
    finally:
        user_conn.close()

    if send_push:
        push_notification_db("all", title, message, "broadcast")

    sent_count = len(users)
    if send_email and users:
        try:
            from routes.auth_routes import send_verification_email
            for u in users:
                email = (u["email"] or "").strip()
                if email and "@" in email:
                    try:
                        send_verification_email(
                            to_email=email,
                            otp_code=message,
                            subject=title,
                            category="broadcast",
                            template_id=template_id,
                            extra_vars={"user_name": u["full_name"] or email.split("@")[0]}
                        )
                    except Exception as mail_err:
                        print(f"[BROADCAST EMAIL ERROR -> {email}]: {mail_err}")
        except Exception as e:
            print(f"[BROADCAST ENGINE ERROR]: {e}")

    adm_conn = get_admin_db_conn()
    try:
        adm_conn.execute(
            """
            UPDATE admin_broadcasts
            SET status = 'sent', recipient_count = ?, sent_at = ?
            WHERE broadcast_id = ?
            """,
            (sent_count, time.time(), broadcast_id)
        )
        adm_conn.commit()
    finally:
        adm_conn.close()


def _background_broadcast_worker():
    time.sleep(5)
    while True:
        try:
            _ensure_broadcast_table()
            now_ts = time.time()
            conn = get_admin_db_conn()
            try:
                due_rows = conn.execute(
                    "SELECT * FROM admin_broadcasts WHERE status = 'scheduled' AND scheduled_for <= ?",
                    (now_ts,)
                ).fetchall()
            finally:
                conn.close()

            for row in due_rows:
                _dispatch_broadcast_now(
                    row["broadcast_id"],
                    row["title"],
                    row["message"],
                    bool(row["send_push"]),
                    bool(row["send_email"]),
                    row["template_id"] if "template_id" in row.keys() else ""
                )
        except Exception as e:
            print(f"[BROADCAST SCHEDULER LOOP ERROR]: {e}")
        time.sleep(30)


def _ensure_worker_in_child_process():
    """Starts the background scheduler lazily inside the forked worker PID, never during import."""
    global _scheduler_started_pid
    pid = os.getpid()
    if _scheduler_started_pid == pid:
        return
    with _scheduler_lock:
        if _scheduler_started_pid == pid:
            return
        _scheduler_started_pid = pid
        t = threading.Thread(target=_background_broadcast_worker, daemon=True)
        t.start()


def start_broadcast_scheduler():
    """Kept for backward compatibility with routes/admin/__init__.py; defers thread creation until post-fork request."""
    pass


@admin_bc_bp.before_app_request
def _lazy_boot_broadcast_scheduler():
    _ensure_worker_in_child_process()


@admin_bc_bp.route('/api/admin/broadcasts', methods=['GET', 'POST'])
def manage_admin_broadcasts():
    if not is_admin_authenticated():
        return jsonify({"error": "Unauthorized"}), 403

    _ensure_broadcast_table()
    if request.method == 'GET':
        conn = get_admin_db_conn()
        try:
            rows = conn.execute(
                "SELECT * FROM admin_broadcasts ORDER BY created_at DESC LIMIT 30"
            ).fetchall()
            return jsonify({"success": True, "broadcasts": [dict(r) for r in rows]})
        finally:
            conn.close()

    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    message = (data.get("message") or "").strip()
    template_id = (data.get("template_id") or "").strip()
    send_push = bool(data.get("send_push", True))
    send_email = bool(data.get("send_email", True))
    schedule_mode = (data.get("schedule_mode") or "now").strip()
    scheduled_at_iso = (data.get("scheduled_at") or "").strip()

    if not title or not message:
        return jsonify({"success": False, "error": "Broadcast title and message are required."}), 400
    if not send_push and not send_email:
        return jsonify({"success": False, "error": "Select at least Push Notification or Email delivery."}), 400

    now_ts = time.time()
    sched_ts = now_ts

    if schedule_mode == "schedule":
        if not scheduled_at_iso:
            return jsonify({"success": False, "error": "Select date and time for scheduled broadcast."}), 400
        try:
            dt = datetime.fromisoformat(scheduled_at_iso)
            sched_ts = dt.timestamp()
        except Exception:
            return jsonify({"success": False, "error": "Invalid date/time format."}), 400

    bid = f"bc_{uuid.uuid4().hex[:8]}"
    conn = get_admin_db_conn()
    try:
        conn.execute(
            """
            INSERT INTO admin_broadcasts
            (broadcast_id, title, message, template_id, send_push, send_email, scheduled_for, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                bid,
                title,
                message,
                template_id,
                int(send_push),
                int(send_email),
                sched_ts,
                "scheduled" if sched_ts > now_ts + 5 else "sending",
                now_ts
            )
        )
        conn.commit()
    finally:
        conn.close()

    if sched_ts <= now_ts + 5:
        threading.Thread(
            target=_dispatch_broadcast_now,
            args=(bid, title, message, send_push, send_email, template_id),
            daemon=True
        ).start()
        return jsonify({"success": True, "message": "Broadcast dispatched immediately to all users!"})

    return jsonify({"success": True, "message": f"Broadcast scheduled for {scheduled_at_iso.replace('T', ' ')}!"})


@admin_bc_bp.route('/api/admin/broadcasts/delete', methods=['POST'])
def delete_admin_broadcast():
    if not is_admin_authenticated():
        return jsonify({"error": "Unauthorized"}), 403
    bid = ((request.get_json(silent=True) or {}).get("broadcast_id") or "").strip()
    conn = get_admin_db_conn()
    try:
        conn.execute("DELETE FROM admin_broadcasts WHERE broadcast_id = ?", (bid,))
        conn.commit()
        return jsonify({"success": True, "message": "Broadcast record removed."})
    finally:
        conn.close()