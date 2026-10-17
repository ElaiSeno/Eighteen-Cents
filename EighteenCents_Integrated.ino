#include <Wire.h>
#include <U8g2lib.h>
#include <Keypad.h>
#include <ESP32Servo.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <math.h>

// =====================================
// WI-FI AND API SETTINGS
// =====================================
const char* WIFI_SSID = "EighteenCents";
const char* WIFI_PASSWORD = "YourPersonalMoneyTracker_EC18";

const char* API_URL = "http://192.168.137.1/Eighteen_Cents/api/transactions.php";

const char* MACHINE_API_KEY =
  "CEighteenCents_ESP32_9fK7mQ2vX8pL5nR4_Tx2026";



// =====================================
// OLED SETUP
// =====================================
#define OLED_ADDRESS 0x3C

U8G2_SH1106_128X64_NONAME_F_HW_I2C oled(
  U8G2_R0,
  U8X8_PIN_NONE
);

// If your OLED is SSD1306 instead, use this:
// U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(
//   U8G2_R0, U8X8_PIN_NONE
// );

const int OLED_MAX_CHARS = 14;                    // 126 px / 9 px per character
const unsigned long SCROLL_START_PAUSE = 900;     // wait before sliding starts
const unsigned long SCROLL_STEP_MS = 250;         // lower = faster sliding

class OLEDText {
  int col = 0;
  int row = 0;
  String lines[2] = {"", ""};
  bool tail[2] = {false, false};   // true = show the END of the text (typing)
  int scrollPos[2] = {0, 0};
  unsigned long nextStep[2] = {0, 0};

  String visible(int r) {
    String s = lines[r];
    if ((int)s.length() <= OLED_MAX_CHARS) return s;

    if (tail[r]) {
      return s.substring(s.length() - OLED_MAX_CHARS);
    }

    String loop = s + "   ";
    int len = loop.length();
    String out = "";
    for (int i = 0; i < OLED_MAX_CHARS; i++) {
      out += loop[(scrollPos[r] + i) % len];
    }
    return out;
  }

  void render() {
    oled.clearBuffer();
    oled.setFont(u8g2_font_9x15B_tf);
    for (int r = 0; r < 2; r++) {
      oled.drawStr(0, r == 0 ? 25 : 57, visible(r).c_str());
    }
    oled.sendBuffer();
  }

  void restartScroll(int r) {
    scrollPos[r] = 0;
    nextStep[r] = millis() + SCROLL_START_PAUSE;
  }

public:
  void begin(int, int) {}
  void setBacklight(int) {}

  void clear() {
    lines[0] = "";
    lines[1] = "";
    tail[0] = tail[1] = false;
    restartScroll(0);
    restartScroll(1);
    col = 0;
    row = 0;
    render();
  }

  void setCursor(int c, int r) {
    col = c;
    row = (r > 0) ? 1 : 0;
  }

  void print(const char* s) { print(String(s)); }

  void print(String s) {
    if (col == 0) lines[row] = "";
    lines[row] += s;
    col += s.length();
    tail[row] = false;
    restartScroll(row);
    render();
  }

  void print(char c) { print(String(c)); }
  void print(long n) { print(String(n)); }
  void print(int n) { print(String(n)); }
  void print(double n, int decimals) { print(String(n, decimals)); }

  // For typing: replaces the line and shows the last characters
  void printTail(String s) {
    lines[row] = s;
    tail[row] = true;
    col = s.length();
    render();
  }

  // Call often; slides any line that is too long
  void tick() {
    bool changed = false;
    unsigned long now = millis();
    for (int r = 0; r < 2; r++) {
      if (!tail[r] && (int)lines[r].length() > OLED_MAX_CHARS &&
          (long)(now - nextStep[r]) >= 0) {
        scrollPos[r] = (scrollPos[r] + 1) % (lines[r].length() + 3);
        nextStep[r] = now + (scrollPos[r] == 0 ? SCROLL_START_PAUSE : SCROLL_STEP_MS);
        changed = true;
      }
    }
    if (changed) render();
  }
};

OLEDText lcd;

// Keeps the text sliding while the sketch is "waiting".
// The #define makes every delay() in this sketch do that.
void smartDelay(unsigned long ms) {
  unsigned long start = millis();
  while (millis() - start < ms) {
    lcd.tick();
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}
#define delay(ms) smartDelay(ms)

// =====================================
// HARDWARE PINS
// =====================================
#define DEPOSIT_BUTTON 27
#define WITHDRAW_BUTTON 26
#define SERVO_PIN 32
#define BUZZER_PIN 33

const byte ROWS = 4;
const byte COLS = 4;

char keys[ROWS][COLS] = {
  {'1', '2', '3', '+'},
  {'4', '5', '6', '-'},
  {'7', '8', '9', 'x'},
  {'*', '0', '#', '/'}
};

byte rowPins[ROWS] = {13, 14, 16, 17};
byte colPins[COLS] = {18, 19, 23, 25};

Keypad keypad = Keypad(
  makeKeymap(keys),
  rowPins,
  colPins,
  ROWS,
  COLS
);

Servo piggyServo;

const int SERVO_CLOSED = 0;
const int SERVO_OPEN = 180;

// The withdraw PIN is no longer stored here.
// It is checked by the website's server, so you can change it from your Profile.
const int PIN_MAX_DIGITS = 8;

// =====================================
// SYSTEM STATES
// =====================================
enum SystemState {
  HOME,
  DEPOSIT_INPUT,
  DEPOSIT_CONFIRM,
  WITHDRAW_PIN,
  WITHDRAW_INPUT,
  WITHDRAW_WAIT_APPROVAL,
  CLAIM,
  WITHDRAW_SAVE_RETRY
};

SystemState state = HOME;

String input = "";
String pinInput = "";

double pendingTotal = 0;

// The ID of the withdrawal request stored in the database
long withdrawalRequestId = 0;

unsigned long lastStatusCheck = 0;
const unsigned long STATUS_CHECK_INTERVAL = 2000;

// =====================================
// BUZZER
// =====================================
void buzzerOff() {
  digitalWrite(BUZZER_PIN, HIGH);
}

void goodBuzz() {
  digitalWrite(BUZZER_PIN, LOW);
  delay(100);
  digitalWrite(BUZZER_PIN, HIGH);
  delay(100);
  digitalWrite(BUZZER_PIN, LOW);
  delay(180);
  digitalWrite(BUZZER_PIN, HIGH);
}

void badBuzz() {
  digitalWrite(BUZZER_PIN, LOW);
  delay(250);
  digitalWrite(BUZZER_PIN, HIGH);
  delay(150);
  digitalWrite(BUZZER_PIN, LOW);
  delay(250);
  digitalWrite(BUZZER_PIN, HIGH);
}

// =====================================
// OLED DISPLAY HELPERS
// =====================================
void clearLCD() {
  lcd.clear();
  lcd.setCursor(0, 0);
}

void showHome() {
  clearLCD();
  lcd.print("EIGHTEEN CENTS");
  lcd.setCursor(0, 1);
  lcd.print("DEPOSIT/WITHDRAW");
}

void displayCalculatorInput() {
  lcd.setCursor(0, 1);
  lcd.printTail(input);
}

void displayMaskedPIN() {
  String masked = "";

  for (unsigned int i = 0; i < pinInput.length(); i++) {
    masked += '*';
  }

  lcd.setCursor(0, 1);
  lcd.printTail(masked);
}

void showTotal(double n) {
  clearLCD();
  lcd.print("TOTAL");
  lcd.setCursor(0, 1);

  if (n == (long)n) {
    lcd.print((long)n);
  } else {
    lcd.print(n, 2);
  }
}

void startDeposit() {
  input = "";

  clearLCD();
  lcd.print("DEPOSIT AMOUNT");
  delay(1200);

  clearLCD();
  lcd.print("ENTER AMOUNT");
}

void showDepositRequest(double n) {
  clearLCD();
  lcd.print("INSERT AMOUNT");
  lcd.setCursor(0, 1);

  if (n == (long)n) {
    lcd.print((long)n);
  } else {
    lcd.print(n, 2);
  }

  delay(1800);

  clearLCD();
  lcd.print("* DONE  # DEL");
}

void startWithdraw() {
  pinInput = "";

  clearLCD();
  lcd.print("ENTER PIN");
  lcd.setCursor(0, 1);
  lcd.print("PIN: ");
}

void startWithdrawAmount() {
  input = "";

  clearLCD();
  lcd.print("WITHDRAW AMOUNT");
  delay(1200);

  clearLCD();
  lcd.print("ENTER AMOUNT");
}

void showClaimPrompt(double n) {
  clearLCD();
  lcd.print("CLAIM AMOUNT");
  lcd.setCursor(0, 1);

  if (n == (long)n) {
    lcd.print((long)n);
  } else {
    lcd.print(n, 2);
  }

  delay(1800);

  clearLCD();
  lcd.print("* DONE  # DEL");
}

// =====================================
// WI-FI
// =====================================
bool connectWiFi(unsigned long timeoutMs = 12000) {
  if (WiFi.status() == WL_CONNECTED) {
    return true;
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long started = millis();

  while (WiFi.status() != WL_CONNECTED &&
         millis() - started < timeoutMs) {
    delay(250);
  }

  return WiFi.status() == WL_CONNECTED;
}

// =====================================
// SEND DEPOSIT TRANSACTION
// Deposits are saved as completed, with no category.
// =====================================
bool sendTransactionToAPI(const char* type, double amount) {
  if (!isfinite(amount) || amount <= 0) {
    Serial.println("Invalid amount");
    return false;
  }

  if (!connectWiFi()) {
    Serial.println("Wi-Fi connection failed");
    return false;
  }

  HTTPClient http;
  http.setTimeout(10000);

  if (!http.begin(API_URL)) {
    Serial.println("Invalid API URL");
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", MACHINE_API_KEY);

  StaticJsonDocument<256> doc;

  doc["action"] = "machine_transaction";
  doc["type"] = type;
  doc["amount"] = amount;
  doc["note"] = "";

  String body;
  serializeJson(doc, body);

  Serial.print("Transaction request: ");
  Serial.println(body);

  int code = http.POST(body);

  if (code < 0) {
    Serial.printf("HTTP error: %s\n", http.errorToString(code).c_str());
  }

  String response = http.getString();

  Serial.printf("API HTTP code: %d\n", code);
  Serial.println(response);

  http.end();

  return code >= 200 && code < 300;
}

// =====================================
// CHECK THE WITHDRAW PIN ON THE SERVER
// Returns 1 = correct, 0 = wrong,
// -1 = could not reach the server.
// The PIN is never printed to the Serial Monitor.
// =====================================
int verifyPinOnServer(const String &pin) {
  if (!connectWiFi()) {
    return -1;
  }

  HTTPClient http;
  http.setTimeout(8000);

  if (!http.begin(API_URL)) {
    return -1;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", MACHINE_API_KEY);

  StaticJsonDocument<192> doc;

  doc["action"] = "verify_pin";
  doc["pin"] = pin;

  String body;
  serializeJson(doc, body);

  int code = http.POST(body);
  String response = http.getString();

  http.end();

  Serial.printf("PIN check HTTP code: %d\n", code);

  if (code < 200 || code >= 300) {
    return -1;
  }

  StaticJsonDocument<256> result;

  if (deserializeJson(result, response)) {
    return -1;
  }

  return (result["valid"] == true) ? 1 : 0;
}

// =====================================
// CREATE WITHDRAWAL REQUEST
// This creates a PENDING transaction.
// The servo must remain CLOSED.
// =====================================
bool createWithdrawalRequest(double amount, long &requestId) {
  requestId = 0;

  if (!isfinite(amount) || amount <= 0) {
    return false;
  }

  if (!connectWiFi()) {
    Serial.println("Wi-Fi connection failed");
    return false;
  }

  HTTPClient http;
  http.setTimeout(10000);

  if (!http.begin(API_URL)) {
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", MACHINE_API_KEY);

  StaticJsonDocument<256> doc;

  doc["action"] = "machine_transaction";
  doc["type"] = "Withdraw";
  doc["amount"] = amount;
  doc["note"] = "";

  String body;
  serializeJson(doc, body);

  int code = http.POST(body);
  String response = http.getString();

  Serial.printf("Withdrawal HTTP code: %d\n", code);
  Serial.println(response);

  bool success = false;

  if (code >= 200 && code < 300) {
    StaticJsonDocument<512> result;
    DeserializationError error = deserializeJson(result, response);

    if (!error && result["transaction_id"].is<long>()) {
      requestId = result["transaction_id"].as<long>();
      success = requestId > 0;
    }
  }

  http.end();
  return success;
}

// =====================================
// CHECK WITHDRAWAL APPROVAL
// Returns pending, approved, cancelled,
// completed, failed, or offline.
// =====================================
String getWithdrawalStatus(long requestId) {
  if (requestId <= 0) {
    return "offline";
  }

  if (!connectWiFi()) {
    return "offline";
  }

  HTTPClient http;
  http.setTimeout(5000);

  if (!http.begin(API_URL)) {
    return "offline";
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", MACHINE_API_KEY);

  StaticJsonDocument<192> doc;

  doc["action"] = "withdrawal_status";
  doc["transaction_id"] = requestId;

  String body;
  serializeJson(doc, body);

  int code = http.POST(body);
  String response = http.getString();

  http.end();

  Serial.printf("Status HTTP code: %d\n", code);
  Serial.println(response);

  if (code < 200 || code >= 300) {
    return "offline";
  }

  StaticJsonDocument<512> result;

  DeserializationError error = deserializeJson(result, response);

  if (error || !result["status"].is<const char*>()) {
    return "offline";
  }

  const char* status = result["status"];
  return String(status);
}

// =====================================
// COMPLETE THE APPROVED WITHDRAWAL
// Updates the SAME transaction row.
// Does NOT create another transaction.
// =====================================
bool completeWithdrawalRequest(long requestId) {
  if (requestId <= 0) {
    return false;
  }

  if (!connectWiFi()) {
    return false;
  }

  HTTPClient http;
  http.setTimeout(10000);

  if (!http.begin(API_URL)) {
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", MACHINE_API_KEY);

  StaticJsonDocument<192> doc;

  doc["action"] = "complete_withdrawal";
  doc["transaction_id"] = requestId;

  String body;
  serializeJson(doc, body);

  int code = http.POST(body);
  String response = http.getString();

  Serial.printf("Complete HTTP code: %d\n", code);
  Serial.println(response);

  bool success = false;

  if (code >= 200 && code < 300) {
    StaticJsonDocument<512> result;

    DeserializationError error = deserializeJson(result, response);

    if (!error && result["success"] == true) {
      success = true;
    }
  }

  http.end();
  return success;
}

// =====================================
// CALCULATOR
// Supports + - x /
// =====================================
double calculateExpression(String e) {
  e.replace(" ", "");

  if (e.length() == 0) {
    return NAN;
  }

  char last = e[e.length() - 1];

  if (last == '+' || last == '-' ||
      last == 'x' || last == '/') {
    return NAN;
  }

  while (true) {
    int m = e.indexOf('x');
    int d = e.indexOf('/');

    if (m == -1 && d == -1) {
      break;
    }

    int p = (m == -1) ? d :
            ((d == -1) ? m : min(m, d));

    int ls = p - 1;

    while (ls >= 0 &&
           (isDigit(e[ls]) || e[ls] == '.')) {
      ls--;
    }

    ls++;

    int re = p + 1;

    while (re < (int)e.length() &&
           (isDigit(e[re]) || e[re] == '.')) {
      re++;
    }

    if (ls >= p || re == p + 1) {
      return NAN;
    }

    double a = e.substring(ls, p).toDouble();
    double b = e.substring(p + 1, re).toDouble();

    if (e[p] == '/' && b == 0) {
      return NAN;
    }

    double result = (e[p] == 'x') ? a * b : a / b;

    e = e.substring(0, ls) +
        String(result, 2) +
        e.substring(re);
  }

  double total = 0;
  int start = 0;
  char op = '+';

  for (int i = 0; i <= (int)e.length(); i++) {
    if (i == (int)e.length() ||
        e[i] == '+' ||
        (e[i] == '-' && i > 0)) {

      String part = e.substring(start, i);

      if (part.length() == 0) {
        return NAN;
      }

      double n = part.toDouble();

      if (op == '+') {
        total += n;
      } else if (op == '-') {
        total -= n;
      }

      if (i < (int)e.length()) {
        op = e[i];
      }

      start = i + 1;
    }
  }

  if (!isfinite(total) || total <= 0) {
    return NAN;
  }

  return total;
}

// =====================================
// HANDLE CALCULATOR KEYS
// =====================================
void handleCalculatorKey(char key) {
  if (key >= '0' && key <= '9') {
    if (input.length() < 14) {
      input += key;
    }
  }
  else if (key == '#') {
    if (input.length()) {
      input.remove(input.length() - 1);
    }
  }
  else if (key == '+' || key == '-' ||
           key == 'x' || key == '/') {

    if (input.length() && input.length() < 14) {
      char last = input[input.length() - 1];

      if (last != '+' && last != '-' &&
          last != 'x' && last != '/') {
        input += key;
      }
    }
  }

  displayCalculatorInput();
}

// =====================================
// TEST WAMP SERVER CONNECTION
// (any HTTP reply, even 401, means the server is reachable)
// =====================================
void testServerConnection() {
  WiFiClient client;

  Serial.println("Testing WAMP server...");
  Serial.println("Target: 192.168.137.1:80");

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("FAILED: ESP32 is not connected to Wi-Fi.");
    return;
  }

  if (client.connect("192.168.137.1", 80)) {
    Serial.println("Server connection: SUCCESS");

    // Request the API endpoint
    client.println(
      "GET /Eighteen_Cents/api/transactions.php HTTP/1.1"
    );
    client.println("Host: 192.168.137.1");
    client.println("Connection: close");
    client.println();

    unsigned long start = millis();

    while (client.connected() &&
           !client.available() &&
           millis() - start < 5000) {
      delay(10);
    }

    if (client.available()) {
      Serial.println("Server response:");

      // Print the first HTTP response line
      String responseLine = client.readStringUntil('\n');
      Serial.println(responseLine);
    } else {
      Serial.println("Connected, but no HTTP response received.");
    }

    client.stop();

  } else {
    Serial.println("Server connection: FAILED");
    Serial.println("Check Windows Firewall and hotspot access.");
  }
}

// =====================================
// SETUP
// =====================================

void setup() {
  Serial.begin(115200);

  Wire.begin(21, 22);
  Wire.setClock(400000);

  oled.begin();
  oled.setI2CAddress(OLED_ADDRESS * 2);
  oled.setPowerSave(0);

  oled.clearBuffer();
  oled.setFont(u8g2_font_helvB12_tf);
  oled.drawStr(0, 25, "EIGHTEEN");
  oled.drawStr(0, 57, "CENTS");
  oled.sendBuffer();

  delay(1500);

  pinMode(DEPOSIT_BUTTON, INPUT_PULLUP);
  pinMode(WITHDRAW_BUTTON, INPUT_PULLUP);

  pinMode(BUZZER_PIN, OUTPUT);
  buzzerOff();

  piggyServo.attach(SERVO_PIN);
  piggyServo.write(SERVO_CLOSED);

  // Connect to Wi-Fi first
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.println("Connecting to Wi-Fi...");

  unsigned long start = millis();

  while (WiFi.status() != WL_CONNECTED &&
         millis() - start < 20000) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("Wi-Fi connected!");

    Serial.print("ESP32 Wi-Fi IP: ");
    Serial.println(WiFi.localIP());

    // Give the connection a moment to stabilize
    delay(1000);

    // Test WAMP only AFTER Wi-Fi connects
    testServerConnection();

  } else {
    Serial.println("Wi-Fi connection FAILED!");
    Serial.println("Check Wi-Fi name and password.");
  }

  showHome();
}

// =====================================
// MAIN LOOP
// =====================================
void loop() {
  lcd.tick();

  // -----------------------------------
  // HOME
  // -----------------------------------
  if (state == HOME) {

    if (digitalRead(DEPOSIT_BUTTON) == LOW) {
      delay(50);

      if (digitalRead(DEPOSIT_BUTTON) == LOW) {
        startDeposit();
        state = DEPOSIT_INPUT;

        while (digitalRead(DEPOSIT_BUTTON) == LOW) {
          delay(10);
        }
      }
    }

    if (digitalRead(WITHDRAW_BUTTON) == LOW) {
      delay(50);

      if (digitalRead(WITHDRAW_BUTTON) == LOW) {
        startWithdraw();
        state = WITHDRAW_PIN;

        while (digitalRead(WITHDRAW_BUTTON) == LOW) {
          delay(10);
        }
      }
    }
  }

  // -----------------------------------
  // DEPOSIT AMOUNT
  // -----------------------------------
  else if (state == DEPOSIT_INPUT) {

    char k = keypad.getKey();

    if (k == '*' && input.length()) {
      double total = calculateExpression(input);

      if (!isfinite(total)) {
        clearLCD();
        lcd.print("INVALID AMOUNT");
        badBuzz();
        delay(1200);
        startDeposit();
      }
      else {
        pendingTotal = total;
        showTotal(total);
        delay(1200);
        showDepositRequest(total);
        state = DEPOSIT_CONFIRM;
      }
    }
    else if (k) {
      handleCalculatorKey(k);
    }
  }

  // -----------------------------------
  // CONFIRM DEPOSIT
  // -----------------------------------
  else if (state == DEPOSIT_CONFIRM) {

    char k = keypad.getKey();

    if (k == '*') {
      clearLCD();
      lcd.print("SAVING DEPOSIT");
      lcd.setCursor(0, 1);
      lcd.print("PLEASE WAIT");

      if (sendTransactionToAPI("Deposit", pendingTotal)) {
        clearLCD();
        lcd.print("DEPOSIT SAVED");
        goodBuzz();
        delay(1800);

        showHome();
        state = HOME;
      }
      else {
        clearLCD();
        lcd.print("SAVE FAILED");
        lcd.setCursor(0, 1);
        lcd.print("* RETRY  # HOME");
        badBuzz();
      }
    }
    else if (k == '#') {
      showHome();
      state = HOME;
    }
  }

  // -----------------------------------
  // WITHDRAWAL PIN (checked by the server)
  // -----------------------------------
  else if (state == WITHDRAW_PIN) {

    char k = keypad.getKey();

    if (k >= '0' && k <= '9' &&
        pinInput.length() < PIN_MAX_DIGITS) {

      pinInput += k;

      // show the new digit for a moment, then hide it
      lcd.setCursor(0, 1);
      lcd.printTail(pinInput);

      delay(250);
      displayMaskedPIN();
    }
    else if (k == '#') {
      if (pinInput.length()) {
        pinInput.remove(pinInput.length() - 1);
      }

      displayMaskedPIN();
    }
    else if (k == '*' && pinInput.length() > 0) {

      clearLCD();
      lcd.print("CHECKING PIN");
      lcd.setCursor(0, 1);
      lcd.print("PLEASE WAIT");

      int pinResult = verifyPinOnServer(pinInput);

      if (pinResult == 1) {
        goodBuzz();
        startWithdrawAmount();
        state = WITHDRAW_INPUT;
      }
      else if (pinResult == 0) {
        clearLCD();
        lcd.print("WRONG PIN");
        lcd.setCursor(0, 1);
        lcd.print("ACCESS DENIED");

        badBuzz();
        delay(1600);

        startWithdraw();
        state = WITHDRAW_PIN;
      }
      else {
        clearLCD();
        lcd.print("API OFFLINE");
        lcd.setCursor(0, 1);
        lcd.print("TRY AGAIN");

        badBuzz();
        delay(1600);

        startWithdraw();
        state = WITHDRAW_PIN;
      }
    }
  }

  // -----------------------------------
  // ENTER WITHDRAWAL AMOUNT
  // -----------------------------------
  else if (state == WITHDRAW_INPUT) {

    char k = keypad.getKey();

    if (k == '*' && input.length()) {
      double total = calculateExpression(input);

      if (!isfinite(total)) {
        clearLCD();
        lcd.print("INVALID AMOUNT");
        badBuzz();
        delay(1200);
        startWithdrawAmount();
      }
      else {
        pendingTotal = total;

        // IMPORTANT: Keep the servo closed.
        piggyServo.write(SERVO_CLOSED);

        clearLCD();
        lcd.print("SENDING REQUEST");
        lcd.setCursor(0, 1);
        lcd.print("PLEASE WAIT");

        long newRequestId = 0;

        if (createWithdrawalRequest(pendingTotal, newRequestId)) {
          withdrawalRequestId = newRequestId;

          clearLCD();
          lcd.print("WAIT APPROVAL");
          lcd.setCursor(0, 1);
          lcd.print("CHECK WEBSITE");

          // Check the API immediately.
          lastStatusCheck = millis() - STATUS_CHECK_INTERVAL;
          state = WITHDRAW_WAIT_APPROVAL;
        }
        else {
          clearLCD();
          lcd.print("REQUEST FAILED");
          lcd.setCursor(0, 1);
          lcd.print("# TO GO HOME");

          badBuzz();
          delay(1800);

          showHome();
          state = HOME;
        }
      }
    }
    else if (k) {
      handleCalculatorKey(k);
    }
  }

  // -----------------------------------
  // WAIT FOR WEBSITE APPROVAL
  // -----------------------------------
  else if (state == WITHDRAW_WAIT_APPROVAL) {

    // The servo must remain closed while pending.
    piggyServo.write(SERVO_CLOSED);

    if (millis() - lastStatusCheck >= STATUS_CHECK_INTERVAL) {
      lastStatusCheck = millis();

      String status = getWithdrawalStatus(withdrawalRequestId);

      Serial.print("Withdrawal status: ");
      Serial.println(status);

      if (status == "approved") {

        // Only an approved request can open the servo.
        clearLCD();
        lcd.print("APPROVED!");
        lcd.setCursor(0, 1);
        lcd.print("OPENING...");
        goodBuzz();
        delay(800);

        piggyServo.write(SERVO_OPEN);

        showClaimPrompt(pendingTotal);
        state = CLAIM;
      }
      else if (status == "cancelled" ||
               status == "failed") {

        piggyServo.write(SERVO_CLOSED);

        clearLCD();
        lcd.print("REQUEST DENIED");
        lcd.setCursor(0, 1);
        lcd.print("SERVO LOCKED");

        badBuzz();
        delay(2000);

        withdrawalRequestId = 0;
        pendingTotal = 0;

        showHome();
        state = HOME;
      }
      else if (status == "pending") {

        clearLCD();
        lcd.print("WAIT APPROVAL");
        lcd.setCursor(0, 1);
        lcd.print("CHECK WEBSITE");
      }
      else if (status == "offline") {

        clearLCD();
        lcd.print("API OFFLINE");
        lcd.setCursor(0, 1);
        lcd.print("RETRYING...");
      }

      // Unknown statuses do not open the servo.
    }
  }

  // -----------------------------------
  // CLAIM APPROVED WITHDRAWAL
  // -----------------------------------
  else if (state == CLAIM) {

    char k = keypad.getKey();

    if (k == '*') {

      // Close the servo before saving completion.
      piggyServo.write(SERVO_CLOSED);

      clearLCD();
      lcd.print("SAVING WITHDRAW");
      lcd.setCursor(0, 1);
      lcd.print("PLEASE WAIT");

      if (completeWithdrawalRequest(withdrawalRequestId)) {

        clearLCD();
        lcd.print("WITHDRAW SAVED");
        goodBuzz();
        delay(1800);

        // Clear the current request only after success.
        withdrawalRequestId = 0;
        pendingTotal = 0;
        input = "";

        showHome();
        state = HOME;
      }
      else {
        clearLCD();
        lcd.print("SAVE FAILED");
        lcd.setCursor(0, 1);
        lcd.print("* RETRY SAVE");

        badBuzz();

        // Keep the same transaction ID for retry.
        state = WITHDRAW_SAVE_RETRY;
      }
    }
  }

  // -----------------------------------
  // RETRY COMPLETING SAME WITHDRAWAL
  // Does not create another transaction.
  // -----------------------------------
  else if (state == WITHDRAW_SAVE_RETRY) {

    // Keep the servo closed during the retry.
    piggyServo.write(SERVO_CLOSED);

    char k = keypad.getKey();

    if (k == '*') {
      clearLCD();
      lcd.print("RETRYING SAVE");
      lcd.setCursor(0, 1);
      lcd.print("PLEASE WAIT");

      if (completeWithdrawalRequest(withdrawalRequestId)) {

        clearLCD();
        lcd.print("WITHDRAW SAVED");
        goodBuzz();
        delay(1800);

        withdrawalRequestId = 0;
        pendingTotal = 0;
        input = "";

        showHome();
        state = HOME;
      }
      else {
        clearLCD();
        lcd.print("SAVE FAILED");
        lcd.setCursor(0, 1);
        lcd.print("* RETRY SAVE");
        badBuzz();
      }
    }
  }
}
