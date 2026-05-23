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

# 🚀 1. यह पूरे फोल्डर और फाइलों का नेस्टेड ट्री स्ट्रक्चर लाएगा
@app.route('/fetch-vault-list', methods=['POST'])
def fetch_vault_list():
    data = request.get_json() or {}
    password = data.get('password')

    if password != SECRET_PRINT_PASSWORD:
        return jsonify({"error": "Unauthorized Access!"}), 403

    # 🧠 पूरे डायरेक्टरी स्ट्रक्चर को स्कैन करने वाला इन-मेमोरी फंक्शन
    def build_tree(current_dir):
        tree = []
        try:
            for entry in os.scandir(current_dir):
                # सिर्फ वैलिड एक्सटेंशन को ही फिल्टर करेंगे
                ext = entry.name.split('.')[-1].lower() if '.' in entry.name else ''
                
                if entry.is_dir():
                    # अगर फोल्डर है, तो उसके अंदर भी स्कैन करो (Recursion)
                    sub_tree = build_tree(entry.path)
                    # सिर्फ वही फोल्डर्स दिखाएं जो खाली न हों या जिनमें हमारी वैलिड फाइल्स हों
                    tree.append({
                        "name": entry.name,
                        "type": "folder",
                        "children": sub_tree
                    })
                elif entry.is_file() and ext in ['pdf', 'jpg', 'jpeg', 'png', 'webp']:
                    # अगर वैलिड फाइल है, तो नाम और साइज लो
                    tree.append({
                        "name": entry.name,
                        "type": "file",
                        "file_type": "pdf" if ext == 'pdf' else "image",
                        "size": entry.stat().st_size
                    })
        except Exception as e:
            print(f"Error scanning {current_dir}: {e}")
        
        # फोल्डर्स पहले दिखें और फाइल्स बाद में, इसके लिए सॉर्टिंग
        return sorted(tree, key=lambda x: (x['type'] != 'folder', x['name'].lower()))

    try:
        # मुख्य डाउनलोड फोल्डर से स्कैनिंग शुरू करें
        vault_tree = build_tree(DOCUMENTS_DIR)
        return jsonify({"tree": vault_tree})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# 🚀 2. यह एंडपॉइंट अब सब-फोल्डर्स के अंदर की फाइलों को भी उनके रिलेटिव पाथ से ढूंढेगा
@app.route('/fetch-file-data', methods=['POST'])
def fetch_file_data():
    data = request.get_json() or {}
    password = data.get('password')
    relative_path = data.get('filename') # अब इसमें फोल्डर का पाथ भी शामिल होगा (e.g., "Folder/Sub/file.pdf")

    if password != SECRET_PRINT_PASSWORD:
        return jsonify({"error": "Unauthorized Access!"}), 403

    if not relative_path:
        return jsonify({"error": "File path is required!"}), 400

    # 🎯 सुरक्षा फिक्स: डायरेक्टरी ट्रैवर्सल अटैक रोकने के लिए सुरक्षित कंबाइन
    secure_path = os.path.normpath(os.path.join(DOCUMENTS_DIR, relative_path))
    
    # पक्का करें कि फाइल मुख्य डायरेक्टरी के बाहर की न हो
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