import os, base64
from flask import Flask, render_template, request, jsonify
from dotenv import load_dotenv

# .env file loaded
load_dotenv()

# access environment variables
SECRET_PRINT_PASSWORD = os.getenv("SECRET_PRINT_PASSWORD")
DOCUMENTS_DIR = os.getenv("DOCUMENTS_DIR")
app = Flask(__name__)

@app.route('/')
def index():
    return render_template('index.html')

# 1. This will retrieve the nested tree structure of the entire folder and its files.
@app.route('/fetch-vault-list', methods=['POST'])
def fetch_vault_list():
    data = request.get_json() or {}
    password = data.get('password')

    if password != SECRET_PRINT_PASSWORD:
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


# 2. This endpoint will now find files inside sub-folders as well using their relative path
@app.route('/fetch-file-data', methods=['POST'])
def fetch_file_data():
    data = request.get_json() or {}
    password = data.get('password')
    relative_path = data.get('filename') # This will now include the folder path as well (e.g., "Folder/Sub/file.pdf")

    if password != SECRET_PRINT_PASSWORD:
        return jsonify({"error": "Unauthorized Access!"}), 403

    if not relative_path:
        return jsonify({"error": "File path is required!"}), 400

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

if __name__ == '__main__':
    app.run(debug=True)