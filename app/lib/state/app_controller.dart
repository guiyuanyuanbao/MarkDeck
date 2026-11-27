import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../api/client.dart';
import '../api/sync_api.dart';
import '../store/database.dart';
import '../sync/driver.dart';

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
  String? serverUrl;
  String? deviceId;
  SyncStatus syncStatus = SyncStatus.unconfigured;
  String? syncError;

  StreamSubscription<SyncStatus>? _statusSub;

  // ---- boot: load stored identity, open the db, wire the driver ----

  Future<void> boot() async {
    if (booted) return;
    final url = await _identity.read(key: _kServer);
    final token = await _identity.read(key: _kToken);
    final devId = await _identity.read(key: _kDeviceId);

    _db = AppDatabase.open(await AppDatabase.defaultPath());

    if (url != null && token != null && devId != null) {
      _configure(url: url, token: token, devId: devId);
      paired = true;
    }
    booted = true;
    notifyListeners();

    if (paired) {
      await driver.reconcile('boot');
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
