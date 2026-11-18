import io
import ssl
import ftplib
import posixpath
import paramiko
from vault_crypto import encrypt_bytes, decrypt_bytes

ALLOWED_EXTENSIONS = {'pdf', 'jpg', 'jpeg', 'png', 'webp', 'ipynb'}


# ========================================================================
# 🔐 CREDENTIAL ENCRYPTION / DECRYPTION HELPERS
# ========================================================================
def encrypt_storage_password(plain_secret: str) -> str:
    """Encrypts hosting SSH/FTP password using AES-256 before storing in SQLite."""
    if not plain_secret:
        return ""
    try:
        return encrypt_bytes(plain_secret.encode("utf-8")).decode("utf-8")
    except Exception as e:
        print(f"[REMOTE SECRET ENCRYPT ERROR]: {e}")
        raise


def decrypt_storage_password(enc_secret: str) -> str:
    """Decrypts hosting SSH/FTP password in memory for active session connection."""
    if not enc_secret:
        return ""
    try:
        return decrypt_bytes(enc_secret.encode("utf-8")).decode("utf-8")
    except Exception as e:
        print(f"[REMOTE SECRET DECRYPT ERROR]: {e}")
        raise


# ========================================================================
# 🌐 CPANEL-COMPATIBLE FTP / FTPS CONNECTION FACTORY
# ========================================================================
def _connect_ftp_client(host: str, port: int, username: str, password: str):
    """Connects via Explicit FTPS (TLS) first for cPanel Pure-FTPd, falling back to plain FTP."""
    try:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        ftps = ftplib.FTP_TLS(context=ctx)
        ftps.connect(host, int(port or 21), timeout=15)
        ftps.login(username, password)
        ftps.prot_p()
        ftps.set_pasv(True)
        return ftps
    except Exception:
        ftp = ftplib.FTP()
        ftp.connect(host, int(port or 21), timeout=15)
        ftp.login(username, password)
        ftp.set_pasv(True)
        return ftp


def _resolve_ftp_start_dir(ftp, requested_path: str):
    """Resolves cPanel chroot-jailed FTP home directories automatically."""
    clean = (requested_path or "/").strip()
    if not clean or clean == "/":
        ftp.cwd("/")
        return ftp.pwd()

    try:
        ftp.cwd(clean)
        return ftp.pwd()
    except ftplib.error_perm:
        pass

    try:
        ftp.cwd("/")
        return ftp.pwd()
    except Exception:
        return "/"


# ========================================================================
# 🔌 CONNECTION VERIFIER (SFTP & CPANEL FTP/FTPS)
# ========================================================================
def test_remote_storage_connection(protocol: str, host: str, port: int, username: str, password: str, base_path: str = "/"):
    """Tests connectivity to SFTP or cPanel FTP/FTPS server."""
    try:
        if protocol == "sftp":
            transport = paramiko.Transport((host, int(port or 22)))
            transport.connect(username=username, password=password)
            sftp = paramiko.SFTPClient.from_transport(transport)
            target = (base_path or ".").strip() or "."
            sftp.listdir(target)
            sftp.close()
            transport.close()
            return True, "SFTP (SSH) connection verified!"
        else:
            ftp = _connect_ftp_client(host, int(port or 21), username, password)
            resolved = _resolve_ftp_start_dir(ftp, base_path)
            ftp.quit()
            return True, f"FTP connection verified (Root: {resolved})!"
    except Exception as e:
        return False, f"Connection failed: {e}"


# ========================================================================
# 📂 RECURSIVE DIRECTORY SCANNER (MLSD + UNIX LIST + WINDOWS LIST)
# ========================================================================
def _parse_ftp_list_line(line: str):
    """Parses Unix and DOS/IIS FTP LIST output lines safely."""
    line = line.strip()
    if not line:
        return None

    if line[0] in ("d", "-", "l"):
        parts = line.split(maxsplit=8)
        if len(parts) < 9:
            return None
        name = parts[8].strip()
        if " -> " in name:
            name = name.split(" -> ")[0].strip()
        is_dir = line.startswith("d")
        size = int(parts[4]) if (not is_dir and parts[4].isdigit()) else 0
        return name, is_dir, size

    parts = line.split(maxsplit=3)
    if len(parts) == 4:
        flag_or_size, name = parts[2], parts[3].strip()
        is_dir = flag_or_size.upper() == "<DIR>"
        size = int(flag_or_size) if (not is_dir and flag_or_size.isdigit()) else 0
        return name, is_dir, size

    return None


def list_remote_directory(storage_row: dict, sub_path: str = "", depth: int = 0):
    """Recursively lists all folders (up to 3 levels) and allowed files from SFTP or FTP."""
    if depth > 3:
        return []

    protocol = storage_row["protocol"]
    host = storage_row["host"]
    port = int(storage_row["port"] or (22 if protocol == "sftp" else 21))
    username = storage_row["username"]
    password = decrypt_storage_password(storage_row["encrypted_secret"])
    base_path = (storage_row["base_path"] or "/").strip() or "/"
    target_dir = sub_path if sub_path else base_path

    def scan_sftp(sftp, current_dir, cur_depth):
        if cur_depth > 3:
            return []
        result = []
        try:
            for attr in sftp.listdir_attr(current_dir):
                name = attr.filename
                if name.startswith("."):
                    continue
                is_dir = str(attr.longname).startswith("d")
                ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
                full_remote = posixpath.join(current_dir, name)
                if is_dir:
                    result.append({
                        "name": name,
                        "type": "folder",
                        "file_type": "folder",
                        "children": scan_sftp(sftp, full_remote, cur_depth + 1),
                        "remote_path": full_remote,
                        "storage_id": storage_row["storage_id"],
                        "provider": "sftp",
                        "account_name": storage_row["label"]
                    })
                elif ext in ALLOWED_EXTENSIONS:
                    result.append({
                        "name": name,
                        "type": "file",
                        "file_type": "pdf" if ext == "pdf" else "image",
                        "size": int(attr.st_size or 0),
                        "remote_path": full_remote,
                        "storage_id": storage_row["storage_id"],
                        "provider": "sftp",
                        "account_name": storage_row["label"]
                    })
        except Exception as e:
            print(f"[SFTP SCAN DIR WARNING] ({current_dir}): {e}")
        return sorted(result, key=lambda x: (x["type"] != "folder", x["name"].lower()))

    def scan_ftp(ftp, current_dir, cur_depth):
        if cur_depth > 3:
            return []
        result = []
        try:
            if cur_depth == 0:
                active_dir = _resolve_ftp_start_dir(ftp, current_dir)
            else:
                ftp.cwd(current_dir)
                active_dir = ftp.pwd()

            raw_items = []
            lines = []
            ftp.retrlines("LIST", lines.append)
            for line in lines:
                parsed = _parse_ftp_list_line(line)
                if parsed:
                    name, is_dir, size = parsed
                    if name not in (".", "..") and not name.startswith("."):
                        raw_items.append((name, is_dir, size))

            if not raw_items:
                try:
                    for name, facts in ftp.mlsd():
                        if name in (".", "..") or name.startswith("."):
                            continue
                        ftype = (facts.get("type") or "").lower()
                        is_dir = ftype == "dir"
                        size = int(facts.get("size", 0)) if str(facts.get("size", "0")).isdigit() else 0
                        raw_items.append((name, is_dir, size))
                except Exception:
                    pass

            for name, is_dir, size in raw_items:
                ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
                full_remote = posixpath.join(active_dir, name)
                if is_dir:
                    sub_children = scan_ftp(ftp, full_remote, cur_depth + 1)
                    ftp.cwd(active_dir)
                    result.append({
                        "name": name,
                        "type": "folder",
                        "file_type": "folder",
                        "children": sub_children,
                        "remote_path": full_remote,
                        "storage_id": storage_row["storage_id"],
                        "provider": "ftp",
                        "account_name": storage_row["label"]
                    })
                elif ext in ALLOWED_EXTENSIONS:
                    result.append({
                        "name": name,
                        "type": "file",
                        "file_type": "pdf" if ext == "pdf" else "image",
                        "size": size,
                        "remote_path": full_remote,
                        "storage_id": storage_row["storage_id"],
                        "provider": "ftp",
                        "account_name": storage_row["label"]
                    })
        except Exception as e:
            print(f"[FTP SCAN DIR WARNING] ({current_dir}): {e}")
        return sorted(result, key=lambda x: (x["type"] != "folder", x["name"].lower()))

    try:
        if protocol == "sftp":
            transport = paramiko.Transport((host, port))
            transport.connect(username=username, password=password)
            sftp = paramiko.SFTPClient.from_transport(transport)
            items = scan_sftp(sftp, target_dir, depth)
            sftp.close()
            transport.close()
            return items
        else:
            ftp = _connect_ftp_client(host, port, username, password)
            items = scan_ftp(ftp, target_dir, depth)
            ftp.quit()
            return items
    except Exception as e:
        print(f"[REMOTE STORAGE LIST ERROR]: {e}")
        return []


# ========================================================================
# 📤 DIRECT UPLOAD, 📥 STREAMING & 🗑️ PERMANENT REMOTE FILE DELETE
# ========================================================================
def upload_remote_file_bytes(storage_row: dict, target_remote_dir: str, filename: str, raw_bytes: bytes):
    """Uploads a file directly to the connected SFTP or FTP server directory."""
    protocol = storage_row["protocol"]
    host = storage_row["host"]
    port = int(storage_row["port"] or (22 if protocol == "sftp" else 21))
    username = storage_row["username"]
    password = decrypt_storage_password(storage_row["encrypted_secret"])
    dest_dir = (target_remote_dir or storage_row["base_path"] or "/").strip() or "/"
    remote_file_path = posixpath.join(dest_dir, filename)

    if protocol == "sftp":
        transport = paramiko.Transport((host, port))
        transport.connect(username=username, password=password)
        sftp = paramiko.SFTPClient.from_transport(transport)
        sftp.putfo(io.BytesIO(raw_bytes), remote_file_path)
        sftp.close()
        transport.close()
    else:
        ftp = _connect_ftp_client(host, port, username, password)
        _resolve_ftp_start_dir(ftp, dest_dir)
        ftp.storbinary(f"STOR {filename}", io.BytesIO(raw_bytes))
        remote_file_path = posixpath.join(ftp.pwd(), filename)
        ftp.quit()

    return remote_file_path


def download_remote_file_bytes(storage_row: dict, remote_file_path: str) -> bytes:
    """Streams raw file bytes directly into memory from SFTP or FTP without touching local disk."""
    protocol = storage_row["protocol"]
    host = storage_row["host"]
    port = int(storage_row["port"] or (22 if protocol == "sftp" else 21))
    username = storage_row["username"]
    password = decrypt_storage_password(storage_row["encrypted_secret"])

    buf = io.BytesIO()
    if protocol == "sftp":
        transport = paramiko.Transport((host, port))
        transport.connect(username=username, password=password)
        sftp = paramiko.SFTPClient.from_transport(transport)
        sftp.getfo(remote_file_path, buf)
        sftp.close()
        transport.close()
    else:
        ftp = _connect_ftp_client(host, port, username, password)
        ftp.retrbinary(f"RETR {remote_file_path}", buf.write)
        ftp.quit()
    return buf.getvalue()


def delete_remote_file(storage_row: dict, remote_file_path: str) -> bool:
    """Permanently deletes a file from the connected SFTP or FTP server."""
    protocol = storage_row["protocol"]
    host = storage_row["host"]
    port = int(storage_row["port"] or (22 if protocol == "sftp" else 21))
    username = storage_row["username"]
    password = decrypt_storage_password(storage_row["encrypted_secret"])

    if protocol == "sftp":
        transport = paramiko.Transport((host, port))
        transport.connect(username=username, password=password)
        sftp = paramiko.SFTPClient.from_transport(transport)
        sftp.remove(remote_file_path)
        sftp.close()
        transport.close()
        return True
    else:
        ftp = _connect_ftp_client(host, port, username, password)
        ftp.delete(remote_file_path)
        ftp.quit()
        return True