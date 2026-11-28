import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

/// Typed API failure carrying the HTTP status so the UI can render
/// 401 (token revoked) vs 429 (rate limited) distinctly.
class ApiException implements Exception {
  ApiException(this.status, this.message);
  final int status;
  final String message;

  bool get isAuth => status == 401;
  bool get isRateLimited => status == 429;

  @override
  String toString() => 'ApiException($status): $message';
}

/// Thin REST client for the MarkDeck server.
///
/// Two independent credentials, matching the server's two auth planes:
///  - device token  -> `Authorization: Bearer` (no CSRF, requireAny routes)
///  - admin session -> markdeck_session cookie + `X-CSRF` header
///    (session-only routes: pair-code creation, device list, TOTP, ...)
class ApiClient {
  ApiClient({http.Client? client}) : _http = client ?? http.Client();

  final http.Client _http;

  String _baseUrl = '';
  String? _deviceToken;
  String? _sessionCookie;
  String? _csrf;
  Duration timeout = const Duration(seconds: 10);

  bool get hasBaseUrl => _baseUrl.isNotEmpty;
  bool get hasDevice => _deviceToken != null;
  bool get hasSession => _sessionCookie != null;
  String get baseUrl => _baseUrl;
  String? get deviceToken => _deviceToken;
  String? get sessionCookie => _sessionCookie;
  String? get csrf => _csrf;

  // ---- configuration ----

  void configure({required String baseUrl, String? deviceToken}) {
    _baseUrl = baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl;
    _deviceToken = deviceToken;
  }

  void setDeviceToken(String token) => _deviceToken = token;

  void setSession({required String cookie, required String csrf}) {
    _sessionCookie = cookie;
    _csrf = csrf;
  }

  void clearSession() {
    _sessionCookie = null;
    _csrf = null;
  }

  void clearAll() {
    _baseUrl = '';
    _deviceToken = null;
    clearSession();
  }

  // ---- request plumbing ----

  Map<String, String> _headers({bool mutating = false, bool admin = false}) {
    final h = <String, String>{'Accept': 'application/json'};
    // admin-channel requests authenticate as the admin session (web-admin
    // semantics on the shared requireAny routes); the device token is
    // deliberately withheld so the server falls through to cookie auth.
    // No session -> no credentials -> server 401 -> the UI prompts login.
    if (!admin && _deviceToken != null) h['Authorization'] = 'Bearer $_deviceToken';
    if (_sessionCookie != null) h['Cookie'] = _sessionCookie!;
    if (_sessionCookie != null && mutating) h['X-CSRF'] = _csrf ?? '';
    return h;
  }

  Uri _uri(String path, [Map<String, String>? query]) {
    final u = Uri.parse('$_baseUrl$path');
    if (query == null || query.isEmpty) return u;
    return u.replace(queryParameters: {...u.queryParameters, ...query});
  }

  Future<dynamic> _run(Future<http.Response> Function() send, {bool mutating = false}) async {
    http.Response resp;
    try {
      resp = await send().timeout(timeout);
    } on TimeoutException {
      throw ApiException(0, 'timeout');
    }
    final body = resp.body;
    dynamic parsed;
    if (body.isNotEmpty) {
      try {
        parsed = jsonDecode(body);
      } on FormatException {
        parsed = null;
      }
    }
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      final msg = parsed is Map && parsed['error'] is String
          ? parsed['error'] as String
          : 'HTTP ${resp.statusCode}';
      throw ApiException(resp.statusCode, msg);
    }
    return parsed;
  }

  Future<dynamic> get(String path, {Map<String, String>? query, bool admin = false}) =>
      _run(() => _http.get(_uri(path, query), headers: _headers(admin: admin)));

  Future<dynamic> post(String path, {Object? body, bool admin = false}) => _run(
        () => _http.post(
          _uri(path),
          headers: _headers(mutating: true, admin: admin)..['Content-Type'] = 'application/json',
          body: body == null ? null : jsonEncode(body),
        ),
        mutating: true,
      );

  Future<dynamic> put(String path, {Object? body, bool admin = false}) => _run(
        () => _http.put(
          _uri(path),
          headers: _headers(mutating: true, admin: admin)..['Content-Type'] = 'application/json',
          body: body == null ? null : jsonEncode(body),
        ),
        mutating: true,
      );

  Future<dynamic> delete(String path, {bool admin = false}) =>
      _run(() => _http.delete(_uri(path), headers: _headers(mutating: true, admin: admin)),
          mutating: true);

  /// Raw bytes fetch (export/download endpoints).
  Future<http.Response> getBytes(String path, {bool admin = false}) async {
    final resp =
        await _http.get(_uri(path), headers: _headers(admin: admin)).timeout(timeout);
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      throw ApiException(resp.statusCode, 'HTTP ${resp.statusCode}');
    }
    return resp;
  }

  // ---- auth: setup detection, pairing, admin login ----

  /// GET /api/auth/state -> {setup, totp}. `setup` true = first run.
  Future<({bool setup, bool totp})> authState() async {
    final j = await get('/api/auth/state') as Map<String, dynamic>;
    return (setup: j['setup'] == true, totp: j['totp'] == true);
  }

  /// POST /api/pair — exchange a 6-digit pair code for a long-lived device
  /// token. Public route; rate-limited per IP (5 fails -> escalating lock).
  Future<({String deviceId, String token})> pair({
    required String code,
    required String deviceName,
  }) async {
    final j = await post('/api/pair', body: {'code': code, 'name': deviceName})
        as Map<String, dynamic>;
    return (deviceId: j['deviceId'] as String, token: j['token'] as String);
  }

  /// POST /api/auth/login — admin session. Stores cookie + csrf, returns csrf.
  Future<String> login({required String password, String? totp}) async {
    final resp = await _http
        .post(
          _uri('/api/auth/login'),
          headers: {'Content-Type': 'application/json', 'Accept': 'application/json'},
          body: jsonEncode({'password': password, if (totp != null && totp.isNotEmpty) 'totp': totp}),
        )
        .timeout(timeout);
    if (resp.statusCode != 200) {
      dynamic parsed;
      try {
        parsed = jsonDecode(resp.body);
      } on FormatException {/* fall through */}
      final msg = parsed is Map && parsed['error'] is String ? parsed['error'] as String : 'HTTP ${resp.statusCode}';
      throw ApiException(resp.statusCode, msg);
    }
    final setCookies = resp.headers['set-cookie'];
    if (setCookies == null || setCookies.isEmpty) {
      throw ApiException(resp.statusCode, 'login response missing session cookie');
    }
    // package:http folds multiple Set-Cookie into one comma-joined value;
    // the session cookie is the first markdeck_session pair.
    final start = setCookies.indexOf('markdeck_session=');
    if (start < 0) {
      throw ApiException(resp.statusCode, 'login response missing markdeck_session');
    }
    final end = setCookies.indexOf(';', start);
    _sessionCookie = end < 0
        ? setCookies.substring(start)
        : setCookies.substring(start, end);
    final parsed = jsonDecode(resp.body) as Map<String, dynamic>;
    _csrf = parsed['csrf'] as String;
    return _csrf!;
  }
}
