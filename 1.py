import csv
import json
import re

# נתיב לקובץ ה־CSV
csv_file_path = "C:\\Users\\neriy\\Downloads\\Telegram Desktop\\AutoResponder_WA_Rules_1752573297.csv"

# מילון שישמר את כל הפקודות והתשובות
commands_dict = {}

# קריאת הקובץ תוך דילוג על השורה הראשונה "sep=,"
with open(csv_file_path, mode='r', encoding='utf-8') as csv_file:
    csv_file.readline()  # דילוג על שורת sep=,
    reader = csv.DictReader(csv_file)
    for row in reader:
        keyword = row.get('received_message', '').strip()
        response = row.get('reply_message', '').strip()

        # החלפת \\ ב־\ בלבד
        keyword = keyword.replace('\\\\', '\\')
        response = response.replace('\\\\', '\\')

        if keyword and response:
            commands_dict[keyword] = response

# עטיפה במפתח אחד בשם "commands"
final_data = {
    "commands": commands_dict
}

# נתיב שמירת הקובץ החדש
output_path = "C:\\Users\\neriy\\OneDrive\\שולחן העבודה\\Dbot\\data\\commands.json"

# כתיבה לקובץ JSON
with open(output_path, mode='w', encoding='utf-8') as json_file:
    json.dump(final_data, json_file, indent=4, ensure_ascii=False)

print(f"✅ הקובץ נשמר בהצלחה בנתיב: {output_path}")
