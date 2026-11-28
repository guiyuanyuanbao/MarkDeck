import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../api/client.dart';
import '../api/sync_api.dart';
import '../store/database.dart';
import '../sync/driver.dart';
import '../ui/theme.dart' show ThemeId, themes;

/// App-wide controller: pairing state, database lifecycle, the sync driver,
/// and the observable state the UI renders. Foundation-only — no widgets.
class AppController extends ChangeNotifier {
  AppController() {
    _identity = const FlutterSecureStorage(
      aOptions: AndroidOptions(resetOnError: true),
    );
    _client = ApiClient();
    _syncApi = SyncApi(_client);
  }

  late final FlutterSecureStorage _identity;
  late final ApiClient _client;
  late final SyncApi _syncApi;

  AppDatabase? _db;
  SyncDriver? _driver;

  bool booted = false;
  bool paired = false;
  bool adminLoggedIn = false;
  String? serverUrl;
  String? deviceId;
  SyncStatus syncStatus = SyncStatus.unconfigured;
  String? syncError;
  String themeId = ThemeId.indigo;

  /// Bumped after every successful sync reconcile — views that read
  /// server-side data outside the mirror (trash) listen to it to refetch.
  int _dataEpoch = 0;
  int get dataEpoch => _dataEpoch;

  StreamSubscription<SyncStatus>? _statusSub;

  // ---- boot: load stored identity, open the db, wire the driver ----

  Future<void> boot() async {
    if (booted) return;
    final url = await _identity.read(key: _kServer);
    final token = await _identity.read(key: _kToken);
    final devId = await _identity.read(key: _kDeviceId);
    final storedTheme = await _identity.read(key: _kTheme);
    if (storedTheme != null && themes.containsKey(storedTheme)) {
      themeId = storedTheme;
    }

    _db = AppDatabase.open(await AppDatabase.defaultPath());

    if (url != null && token != null && devId != null) {
      _configure(url: url, token: token, devId: devId);
      paired = true;
    }
    await _restoreAdminSession();
    booted = true;
    notifyListeners();

    if (paired) {
      await driver.reconcile('boot');
    }
  }

  /// Restore a persisted admin session (cookie + csrf) and validate it
  /// against a session-only route. Optimistically logged-in at boot; a 401
  /// from /api/auth/me clears it (network errors keep it — server may just
  /// be temporarily unreachable).
  Future<void> _restoreAdminSession() async {
    if (!paired) return;
    final cookie = await _identity.read(key: _kAdminCookie);
    final csrf = await _identity.read(key: _kAdminCsrf);
    if (cookie == null || csrf == null) return;
    _client.setSession(cookie: cookie, csrf: csrf);
    adminLoggedIn = true;
    unawaited(_validateAdminSession());
  }

  Future<void> _validateAdminSession() async {
    try {
      await _client.get('/api/auth/me');
    } on ApiException catch (e) {
      if (e.isAuth) await logoutAdmin(notify: true);
    } catch (_) {
      // network/timeout — keep the session, retried on next admin call
    }
  }

  void _configure({
    required String url,
    required String token,
    required String devId,
  }) {
    serverUrl = url;
    deviceId = devId;
    _client.configure(baseUrl: url, deviceToken: token);
    _startDriver(devId);
  }

  void _startDriver(String devId) {
    _driver = SyncDriver(api: _syncApi, db: _db!, deviceId: devId, othersId: 'md-others');
    _statusSub?.cancel();
    _statusSub = _driver!.statusStream.listen((s) {
      syncStatus = s;
      syncError = _driver!.lastError;
      notifyListeners();
    });
    _driver!.onSynced = () {
      _dataEpoch++;
      notifyListeners();
    };
    _driver!.start();
  }

  ApiClient get client => _client;

  SyncDriver get driver {
    final d = _driver;
    if (d == null) throw StateError('boot() before driver access');
    return d;
  }

  AppDatabase get db {
    final d = _db;
    if (d == null) throw StateError('boot() before db access');
    return d;
  }

  // ---- pairing flow (options-page equivalent) ----

  /// Probe GET /api/auth/state, then exchange the 6-digit code for a device
  /// token. Re-pairing wipes the base + mirror (the old base describes a
  /// dead token's world — extension semantics).
  Future<void> pair({
    required String server,
    required String code,
    String deviceName = 'Android',
  }) async {
    final normalized = server.endsWith('/')
        ? server.substring(0, server.length - 1)
        : server;
    _client.configure(baseUrl: normalized);
    await _client.authState(); // probe (throws on bad URL / server down)
    final r = await _client.pair(code: code, deviceName: deviceName);

    await _identity.write(key: _kServer, value: normalized);
    await _identity.write(key: _kToken, value: r.token);
    await _identity.write(key: _kDeviceId, value: r.deviceId);

    await _resetLocal();

    _configure(url: normalized, token: r.token, devId: r.deviceId);
    paired = true;
    notifyListeners();
    await driver.reconcile('pair');
  }

  Future<void> _resetLocal() async {
    await db.delete(db.nodes).go();
    await db.delete(db.baseEntries).go();
    await db.delete(db.touches).go();
    await db.setMetaInt('head', 0);
  }

  /// Unpair (settings: leave the sync set locally).
  Future<void> unpair() async {
    _driver?.stop();
    await _statusSub?.cancel();
    await _identity.deleteAll();
    if (_db != null) await _resetLocal();
    _client.clearAll();
    _driver = null;
    paired = false;
    syncStatus = SyncStatus.unconfigured;
    serverUrl = null;
    deviceId = null;
    notifyListeners();
  }

  /// Manual resync (settings button): clear base, keep touch — the engine
  /// re-adopts everything from the server tree.
  Future<void> forceResync() async {
    if (!paired) return;
    await db.delete(db.baseEntries).go();
    await db.setMetaInt('head', 0);
    await driver.reconcile('force-resync');
  }

  /// Switch the visual theme (靖紫/青蓝/暗夜/琥珀) and persist it.
  Future<void> setTheme(String id) async {
    if (!themes.containsKey(id) || id == themeId) return;
    themeId = id;
    notifyListeners();
    await _identity.write(key: _kTheme, value: id);
  }

  // ---- admin session (device pairing is separate; see unpair) ----

  /// Admin password (+TOTP) login. The session cookie + csrf are persisted
  /// to Keystore so gating survives app restarts; expiry is handled lazily
  /// (admin routes turn a 401 into a re-login prompt).
  Future<void> loginAdmin({required String password, String? totp}) async {
    await _client.login(password: password, totp: totp);
    adminLoggedIn = true;
    notifyListeners();
    final cookie = _client.sessionCookie;
    final csrf = _client.csrf;
    if (cookie != null) await _identity.write(key: _kAdminCookie, value: cookie);
    if (csrf != null) await _identity.write(key: _kAdminCsrf, value: csrf);
  }

  /// Admin logout: best-effort server-side session revoke, then drop the
  /// local session. Pairing is untouched — the device keeps syncing.
  Future<void> logoutAdmin({bool notify = true}) async {
    try {
      await _client.post('/api/auth/logout');
    } catch (_) {
      // already expired / offline — local clear is enough
    }
    _client.clearSession();
    adminLoggedIn = false;
    await _identity.delete(key: _kAdminCookie);
    await _identity.delete(key: _kAdminCsrf);
    if (notify) notifyListeners();
  }

  // ---- lifecycle ----

  void onAppResume() {
    if (paired) {
      driver.reconcile('resume');
    }
  }

  void onAppPause() {
    _driver?.stop();
  }

  @override
  void dispose() {
    _statusSub?.cancel();
    _driver?.stop();
    _db?.close();
    super.dispose();
  }
}

const _kServer = 'md_server';
const _kToken = 'md_token';
const _kDeviceId = 'md_device_id';
const _kTheme = 'md_theme';
const _kAdminCookie = 'md_admin_cookie';
const _kAdminCsrf = 'md_admin_csrf';
