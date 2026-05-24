import os, base64, uuid, io, qrcode
from flask import Flask, render_template, request, jsonify
from dotenv import load_dotenv

# .env file loaded
load_dotenv()

# access environment variables
SECRET_PRINT_PASSWORD = os.getenv("SECRET_PRINT_PASSWORD")
DOCUMENTS_DIR = os.getenv("DOCUMENTS_DIR")
app = Flask(__name__)

# In-memory database for tracking QR sessions
# Structure: { "session_id_123": {"status": "pending", "password_verified": False} }
qr_sessions = {}

# 1.The QR code generated on the desktop will now contain only a plain Session ID—no direct link!
@app.route('/generate-qr-session', methods=['GET'])
def generate_qr_session():
    session_id = str(uuid.uuid4())
    qr_sessions[session_id] = {"status": "pending"}
    
    # Security: There is no URL inside the QR code—just plain `session_id` text!
    qr = qrcode.QRCode(version=1, box_size=10, border=5)
    qr.add_data(session_id)
    qr.make(fit=True)
    
    img = qr.make_image(fill_color="black", back_color="white")
    buffered = io.BytesIO()
    img.save(buffered, format="PNG")
    qr_base64 = base64.b64encode(buffered.getvalue()).decode('utf-8')
    
    return jsonify({
        "session_id": session_id,
        "qr_image": f"data:image/png;base64,{qr_base64}"
    })

# 2. Your Secret Master Scanner Link (Keep this open on your mobile phone)
@app.route('/scan', methods=['GET'])
def my_private_scanner():
    # This page will open on a mobile device and directly activate the built-in camera.
    return '''
    <!DOCTYPE html>
    <html>
    <head>
        <title>🔒 PrintSafe Private Scanner</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <script src="https://unpkg.com/html5-qrcode"></script>
        <style>
            body { font-family: sans-serif; text-align: center; background: #f1f5f9; padding: 20px; color: #1e293b; }
            #reader { width: 100%; max-width: 400px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
            .status { font-weight: bold; color: #2563eb; margin-top: 15px; }
        </style>
    </head>
    <body>
        <h2>🔒 Master Scanner Active</h2>
        <p>Scan the QR code displayed on the desktop.</p>
        
        <div id="reader"></div>
        <div id="scanned-status" class="status">📷 Waiting for the camera to start....</div>

        <script>
            const html5QrCode = new Html5Qrcode("reader");
            const config = { fps: 10, qrbox: { width: 250, height: 250 } };

            // Logic for enabling the back camera
            html5QrCode.start({ facingMode: "environment" }, config, onScanSuccess)
            .then(() => {
                document.getElementById('scanned-status').innerText = "⏳ Ready to scan QR...";
            })
            .catch(err => {
                document.getElementById('scanned-status').innerText = "❌ Camera access denied!";
            });

            async function onScanSuccess(decodedText, decodedResult) {
                // As soon as the camera detects the QR code (Session ID):
                document.getElementById('scanned-status').innerText = "Authenticating......";
                html5QrCode.stop(); // Stop Camera

                // Send an approval request to the server backend.
                try {
                    const res = await fetch('/verify-private-scan/' + decodedText, { method: 'POST' });
                    if(res.ok) {
                        document.getElementById('scanned-status').innerHTML = "<span style='color:green;'>✅ Desktop logged in!</span>";
                    } else {
                        document.getElementById('scanned-status').innerHTML = "<span style='color:red;'>❌ Invalid or expired QR!</span>";
                    }
                } catch(e) {
                    document.getElementById('scanned-status').innerText = "❌ Network Error!";
                }
            }
        </script>
    </body>
    </html>
    '''

# 3. The mobile will send a POST request to scan,
# and the desktop will send a GET request to check the status.
@app.route('/verify-private-scan/<session_id>', methods=['GET', 'POST'])
def verify_private_scan(session_id):
    if session_id not in qr_sessions:
        return jsonify({"error": "Invalid Session"}), 404

    # When the mobile master scanner scans and sends data:
    if request.method == 'POST':
        qr_sessions[session_id] = {"status": "authenticated"}
        return jsonify({"success": True, "message": "Authenticated by Mobile"}), 200

    # When the desktop (or laptop) sends a GET request every 2/3 seconds to check the status:
    if qr_sessions[session_id].get("status") == "authenticated":
        return jsonify({"success": True, "status": "authenticated"}), 200
        
    # 🎯 Returns success: False if status is 'pending' or 'terminated', forcing desktop layout lock
    return jsonify({"success": False, "status": qr_sessions[session_id].get("status")}), 200
    

@app.route('/')
def index():
    return render_template('index.html')

# 1. This will retrieve the nested tree structure of the entire folder and its files.
@app.route('/fetch-vault-list', methods=['POST'])
def fetch_vault_list():
    data = request.get_json() or {}
    password = data.get('password')
    session_id = data.get('session_id') # The session ID sent from JavaScript will be captured here.

    # Magic Check: Either the manually entered password must be correct,
    # or this QR session must have already been approved via mobile.
    is_password_valid = (password == SECRET_PRINT_PASSWORD)
    is_qr_valid = (session_id in qr_sessions and qr_sessions[session_id].get("status") == "authenticated")

    # If either of the two is true, let them in; otherwise, throw a 403.
    if not (is_password_valid or is_qr_valid):
        return jsonify({"error": "Unauthorized Access!"}), 403

    # An in-memory function that scans the entire directory structure.
    def build_tree(current_dir):
        tree = []
        try:
            for entry in os.scandir(current_dir):
                # Filter only valid extensions
                ext = entry.name.split('.')[-1].lower() if '.' in entry.name else ''
                
                if entry.is_dir():
                    # If it's a folder, scan inside it (Recursion)
                    sub_tree = build_tree(entry.path)
                    # Show only those folders which are not empty or contain our valid files
                    tree.append({
                        "name": entry.name,
                        "type": "folder",
                        "children": sub_tree
                    })
                elif entry.is_file() and ext in ['pdf', 'jpg', 'jpeg', 'png', 'webp']:
                    # If it is a valid file, take its name and size.
                    tree.append({
                        "name": entry.name,
                        "type": "file",
                        "file_type": "pdf" if ext == 'pdf' else "image",
                        "size": entry.stat().st_size
                    })
        except Exception as e:
            print(f"Error scanning {current_dir}: {e}")
        
        # Sorting to display folders first and files afterwards.
        return sorted(tree, key=lambda x: (x['type'] != 'folder', x['name'].lower()))

    try:
        # Start scanning from the main download folder
        vault_tree = build_tree(DOCUMENTS_DIR)
        return jsonify({"tree": vault_tree})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

def get_windows_file_type(file_name, is_folder=False):
    """Dynamically creating Windows-style types from filenames without any hardcoding."""
    if is_folder:
        return "File folder"
    
    _, ext = os.path.splitext(file_name)
    
    if not ext:
        return "Unknown File"
        
    clean_ext = ext.replace('.', '').upper()
    
    # direct dynamic name return ('PY File', 'PDF File', 'PNG File')
    return f"{clean_ext} File"

# 2. This endpoint will now find files inside sub-folders as well using their relative path
@app.route('/fetch-file-data', methods=['POST'])
def fetch_file_data():
    data = request.get_json() or {}
    password = data.get('password')
    relative_path = data.get('filename') # This will now include the folder path as well
    session_id = data.get('session_id') # QR session ID catch from js

    if not relative_path:
        return jsonify({"error": "File path is required!"}), 400

    # Magic Security Check: Either the manual password must be correct,
    # or this QR session must have already been authenticated via mobile.
    is_password_valid = (password == SECRET_PRINT_PASSWORD)
    is_qr_valid = (session_id in qr_sessions and qr_sessions[session_id].get("status") == "authenticated")

    if not (is_password_valid or is_qr_valid):
        return jsonify({"error": "Unauthorized Access!"}), 403

    # Security Fix: Securely combine paths to prevent directory traversal attacks
    secure_path = os.path.normpath(os.path.join(DOCUMENTS_DIR, relative_path))

    # Ensure the file is not outside the main directory
    if not secure_path.startswith(os.path.normpath(DOCUMENTS_DIR)):
        return jsonify({"error": "Access Denied!"}), 403

    if not os.path.exists(secure_path):
        return jsonify({"error": "File not found!"}), 404

    try:
        with open(secure_path, "rb") as f:
            encoded_string = base64.b64encode(f.read()).decode('utf-8')
        return jsonify({"base64": encoded_string})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# 🎯 FIX: Remote termination route to invalidate active desktop linked sessions
@app.route('/terminate-desktop-session', methods=['POST'])
def terminate_desktop_session():
    try:
        data = request.get_json() or {}
        session_id = data.get('session_id')
        
        if not session_id:
            return jsonify({"success": False, "error": "Missing session identifier token"}), 400
            
        # Intercept and mutate the active session memory layout state
        if session_id in qr_sessions:
            # Overwriting the status drops the success state inside the desktop's polling interval
            qr_sessions[session_id] = {"status": "terminated"}
            print(f"Success: Remote kill command executed securely for session: {session_id}")
            return jsonify({"success": True, "message": "Session terminated cleanly"}), 200
        else:
            return jsonify({"success": False, "error": "Session token registry mismatch"}), 404
            
    except Exception as e:
        print(f"Critical failure inside termination route engine: {str(e)}")
        return jsonify({"success": False, "error": "Internal infrastructure crash"}), 500

if __name__ == '__main__':
    # app.run(debug=True)
    app.run(host='0.0.0.0', port=8080, debug=True, threaded=True, ssl_context='adhoc')