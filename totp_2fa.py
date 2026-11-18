import io
import base64
import pyotp
import qrcode


# ========================================================================
# 🛡️ AUTHENTICATOR APP 2FA ENGINE (GOOGLE / MICROSOFT / AUTHY TOTP)
# ========================================================================
def generate_totp_setup(account_email: str, issuer_name: str = "PrintSafe Cloud"):
    """Generates a new Base32 TOTP secret, provisioning URI, and base64 QR code."""
    try:
        secret = pyotp.random_base32()
        totp = pyotp.TOTP(secret)
        uri = totp.provisioning_uri(name=account_email, issuer_name=issuer_name)

        qr = qrcode.QRCode(version=1, box_size=8, border=3)
        qr.add_data(uri)
        qr.make(fit=True)
        img = qr.make_image(fill_color="#0f172a", back_color="white")

        buf = io.BytesIO()
        img.save(buf, format="PNG")
        qr_b64 = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("utf-8")

        return {
            "secret": secret,
            "uri": uri,
            "qr_image": qr_b64
        }
    except Exception as e:
        print(f"[2FA SETUP ERROR]: {e}")
        raise


def verify_totp_code(secret: str, code: str) -> bool:
    """Verifies a 6-digit TOTP code from Google/Microsoft Authenticator (with 1-step clock drift tolerance)."""
    if not secret or not code:
        return False
    try:
        clean_code = "".join(ch for ch in str(code) if ch.isdigit())
        if len(clean_code) != 6:
            return False
        totp = pyotp.TOTP(secret)
        return bool(totp.verify(clean_code, valid_window=1))
    except Exception as e:
        print(f"[2FA VERIFY ERROR]: {e}")
        return False