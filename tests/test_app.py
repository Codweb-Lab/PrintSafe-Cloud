import os
import sys
import pytest

# Ensure project root is on sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app import app as flask_app


@pytest.fixture
def client():
    flask_app.config["TESTING"] = True
    flask_app.config["SECRET_KEY"] = "test-secret-key-printsafe"
    with flask_app.test_client() as test_client:
        yield test_client


def test_critical_dependencies_importable():
    """Verify all runtime dependencies required in production are installed."""
    import psutil
    import paramiko
    import pyotp
    import cryptography
    assert psutil is not None
    assert paramiko is not None
    assert pyotp is not None
    assert cryptography is not None


def test_root_serves_login_page(client):
    """Unauthenticated '/' must render login.html with 200 OK."""
    res = client.get("/")
    assert res.status_code == 200
    assert b"PrintSafe" in res.data


def test_unauthenticated_vault_route_redirects_to_login(client):
    """Unauthenticated access to /v/<token> must redirect back to '/'."""
    res = client.get("/v/deadbeef12345678", follow_redirects=False)
    assert res.status_code == 302
    assert res.headers["Location"].endswith("/")


def test_protected_api_blocks_unauthenticated_requests(client):
    """Protected APIs must return 403 when no active session exists."""
    res = client.get("/api/poll-events")
    assert res.status_code == 403


def test_authenticated_session_redirects_to_vault_token(client):
    """Authenticated session at '/' must redirect to /v/<vault_route_token>."""
    with client.session_transaction() as sess:
        sess["is_authenticated"] = True
        sess["user_id"] = "usr_test123"
        sess["user_email"] = "test@printsafe.cloud"
        sess["login_type"] = "user_account"
        sess["vault_route_token"] = "a1b2c3d4e5f60718"

    res = client.get("/", follow_redirects=False)
    assert res.status_code == 302
    assert "/v/a1b2c3d4e5f60718" in res.headers["Location"]

    # Wrong token must redirect to the active session token
    wrong = client.get("/v/wrongtoken000000", follow_redirects=False)
    assert wrong.status_code == 302
    assert "/v/a1b2c3d4e5f60718" in wrong.headers["Location"]


def test_logout_clears_session_and_redirects(client):
    """POST /api/logout must clear auth flags and return redirect to '/'."""
    with client.session_transaction() as sess:
        sess["is_authenticated"] = True
        sess["session_id"] = "usr_test123"
        sess["vault_route_token"] = "a1b2c3d4e5f60718"

    res = client.post("/api/logout")
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is True
    assert data["redirect"] == "/"

    check = client.get("/api/check-session").get_json()
    assert check["authenticated"] is False