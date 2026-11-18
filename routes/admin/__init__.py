from routes.admin.auth_ops import admin_auth_bp
from routes.admin.integrations_ops import admin_int_bp
from routes.admin.vault_users_ops import admin_vu_bp
from routes.admin.broadcast_ops import admin_bc_bp, start_broadcast_scheduler
from routes.admin.templates_ops import admin_tpl_bp


def register_admin_modules(parent_bp):
    parent_bp.register_blueprint(admin_auth_bp)
    parent_bp.register_blueprint(admin_int_bp)
    parent_bp.register_blueprint(admin_vu_bp)
    parent_bp.register_blueprint(admin_bc_bp)
    parent_bp.register_blueprint(admin_tpl_bp)
    start_broadcast_scheduler()