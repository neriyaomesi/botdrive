import json

input_path = "C:\\Users\\neriy\\OneDrive\\שולחן העבודה\\Dbot\\data\\commands.json"
output_path = "C:\\Users\\neriy\\OneDrive\\שולחן העבודה\\Dbot\\data\\commands_fixed.json"

# פונקציה רקורסיבית שמעבדת ערכים: מחליפה \\n ב־ \n אמיתי
def replace_escaped_newlines(obj):
    if isinstance(obj, dict):
        return {k: replace_escaped_newlines(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [replace_escaped_newlines(item) for item in obj]
    elif isinstance(obj, str):
        return obj.replace("\\n", "\n")
    else:
        return obj

# פונקציה למיון עברי לפי מפתחות
def sort_dict_by_keys_hebrew(d):
    return dict(sorted(d.items(), key=lambda x: x[0]))

try:
    with open(input_path, encoding="utf-8") as f:
        data = json.load(f)
    print("✅ JSON נטען בהצלחה!")

    # עיבוד תוכן הפקודות
    fixed_data = replace_escaped_newlines(data)

    # מיון לפי א-ב עברי (לפי המפתחות)
    sorted_data = sort_dict_by_keys_hebrew(fixed_data)

    # שמירה לקובץ חדש
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(sorted_data, f, ensure_ascii=False, indent=2)

    print(f"✅ נשמר בהצלחה ל־ {output_path} כשהפקודות ממוינות לפי א'־ב'!")

except json.JSONDecodeError as e:
    print("❌ שגיאת JSON:")
    print(e)











