import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Device identity persisted in Android Keystore via flutter_secure_storage.
/// Holds the pair result (server URL + device token + ids) — the only
/// secret-class data the app keeps; everything else lives in SQLite.
class SecureIdentity {
  SecureIdentity({FlutterSecureStorage? storage})
      : _storage = storage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(resetOnError: true),
            );

  final FlutterSecureStorage _storage;

  static const _kServer = 'md_server';
  static const _kToken = 'md_token';
  static const _kDeviceId = 'md_device_id';
  static const _kAdminCsrf = 'md_admin_csrf';

  Future<String?> get serverUrl => _storage.read(key: _kServer);
  Future<String?> get deviceToken => _storage.read(key: _kToken);
  Future<String?> get deviceId => _storage.read(key: _kDeviceId);
  Future<String?> get adminCsrf => _storage.read(key: _kAdminCsrf);

  Future<void> savePair({
    required String serverUrl,
    required String token,
    required String deviceId,
  }) async {
    await _storage.write(key: _kServer, value: serverUrl);
    await _storage.write(key: _kToken, value: token);
    await _storage.write(key: _kDeviceId, value: deviceId);
  }

  Future<void> saveAdminCsrf(String csrf) =>
      _storage.write(key: _kAdminCsrf, value: csrf);

  /// Re-pairing invalidates the old base — wipe everything (extension
  /// semantics: a failed/old-world base must never survive a new pairing).
  Future<void> wipe() => _storage.deleteAll();
}