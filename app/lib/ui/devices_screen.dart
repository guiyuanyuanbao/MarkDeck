import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/client.dart' show ApiException;
import '../state/app_controller.dart';
import 'admin_screen.dart';
import 'theme.dart';

/// 配对设备 (web SettingsDevices): pair-code generation + device list with
/// revoke. Admin-session routes — opened from 我的 (already gated), but a
/// stale/expired session surfaces a re-login card instead of an empty list.
class DevicesScreen extends StatefulWidget {
  const DevicesScreen({super.key});

  @override
  State<DevicesScreen> createState() => _DevicesScreenState();
}

class _DevicesScreenState extends State<DevicesScreen> {
  final _name = TextEditingController();
  bool _busyCode = false;
  String? _code;
  List<Map<String, dynamic>>? _devices;
  bool _authRequired = false;
  String? _error;

  AppController get _app => context.read<AppController>();

  @override
  void initState() {
    super.initState();
    _loadDevices();
  }

  Future<void> _loadDevices() async {
    setState(() {
      _authRequired = false;
      _error = null;
    });
    try {
      final r = await _app.client.get('/api/devices') as Map<String, dynamic>;
      setState(() => _devices = (r['devices'] as List? ?? []).cast<Map<String, dynamic>>());
    } on ApiException catch (e) {
      if (e.isAuth) {
        // session expired/revoked server-side — clear local admin state
        await _app.logoutAdmin(notify: false);
        if (mounted) setState(() => _authRequired = true);
      } else if (mounted) {
        setState(() => _error = e.message);
      }
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  Future<void> _loginAndRetry() async {
    await Navigator.push(context, MaterialPageRoute(builder: (_) => const AdminScreen()));
    if (mounted) await _loadDevices();
  }

  Future<void> _newPairCode() async {
    setState(() => _busyCode = true);
    try {
      final r = await _app.client.post('/api/pair-code', body: {
        if (_name.text.trim().isNotEmpty) 'deviceName': _name.text.trim(),
      }) as Map<String, dynamic>;
      setState(() => _code = r['code'] as String);
    } on ApiException catch (e) {
      if (e.isAuth) {
        await _app.logoutAdmin(notify: false);
        if (mounted) setState(() => _authRequired = true);
      } else {
        _toast(e.isRateLimited ? '尝试过多，请稍候再试' : '生成失败：${e.message}');
      }
    } catch (e) {
      _toast('生成失败：$e');
    } finally {
      if (mounted) setState(() => _busyCode = false);
    }
  }

  Future<void> _revoke(String id, String name) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('吊销设备'),
        content: Text('吊销「$name」？该设备将无法再同步。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: MdTheme.of(ctx).danger),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('吊销'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await _app.client.delete('/api/devices/$id');
    } catch (e) {
      if (mounted) _toast('吊销失败：$e');
      return;
    }
    await _loadDevices();
  }

  void _toast(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    final p = MdTheme.of(context);
    return Scaffold(
      backgroundColor: p.bg,
      appBar: AppBar(title: const Text('配对设备')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // ---- pair-code card (hidden until an admin session exists) ----
          if (!_authRequired)
            Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: p.surface,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: p.border),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text('配对新设备',
                    style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700, color: p.text)),
                const SizedBox(height: 4),
                Text('生成一次性配对码，在目标设备的 App 中输入',
                    style: TextStyle(fontSize: 12, color: p.text3)),
                const SizedBox(height: 12),
                TextField(
                  controller: _name,
                  decoration: const InputDecoration(labelText: '设备名（可选）'),
                ),
                const SizedBox(height: 12),
                FilledButton.icon(
                  onPressed: _busyCode ? null : _newPairCode,
                  icon: const Icon(Icons.add_link),
                  label: const Text('生成配对码'),
                ),
                if (_code != null) ...[
                  const SizedBox(height: 16),
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: p.primarySoft,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Column(
                      children: [
                        Text(
                          _code!,
                          style: TextStyle(
                            fontSize: 28,
                            letterSpacing: 8,
                            fontWeight: FontWeight.w800,
                            color: p.primary,
                          ),
                        ),
                        const SizedBox(height: 6),
                        Text('5 分钟内有效 · 一次性',
                            style: TextStyle(fontSize: 12, color: p.text2)),
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 16),
          // ---- device list ----
          Text('已配对设备',
              style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700, color: p.text)),
          const SizedBox(height: 8),
          if (_authRequired)
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: p.surface,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: p.border),
              ),
              child: Column(
                children: [
                  Icon(Icons.lock_outline, size: 28, color: p.text3),
                  const SizedBox(height: 8),
                  Text('管理员登录已过期',
                      style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: p.text)),
                  const SizedBox(height: 4),
                  Text('设备管理需要管理员身份，请重新登录',
                      style: TextStyle(fontSize: 12, color: p.text3)),
                  const SizedBox(height: 12),
                  FilledButton.icon(
                    onPressed: _loginAndRetry,
                    icon: const Icon(Icons.admin_panel_settings_outlined, size: 18),
                    label: const Text('管理员登录'),
                  ),
                ],
              ),
            )
          else if (_error != null)
            Container(
              padding: const EdgeInsets.all(16),
              alignment: Alignment.center,
              child: Column(
                children: [
                  Text('加载失败：$_error',
                      style: TextStyle(color: p.danger, fontSize: 12.5),
                      textAlign: TextAlign.center),
                  const SizedBox(height: 8),
                  TextButton(onPressed: _loadDevices, child: const Text('重试')),
                ],
              ),
            )
          else if (_devices == null)
            Center(child: CircularProgressIndicator(color: p.primary))
          else if (_devices!.isEmpty)
            Container(
              padding: const EdgeInsets.all(24),
              alignment: Alignment.center,
              child: Text('还没有其它设备', style: TextStyle(color: p.text3)),
            )
          else
            ..._devices!.map(_deviceRow),
        ],
      ),
    );
  }

  Widget _deviceRow(Map<String, dynamic> d) {
    final p = MdTheme.of(context);
    final isSelf = d['id'] == _app.deviceId;
    final online = d['online'] == true;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: p.border),
      ),
      child: Row(
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: p.primarySoft,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(
              isSelf ? Icons.phone_android : Icons.devices_other,
              size: 18,
              color: p.primary,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${d['name']}',
                    style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: p.text)),
                Text(
                  online ? '在线' : '最后在线：${d['lastSeen'] ?? '-'}',
                  style: TextStyle(
                      fontSize: 12, color: online ? p.success : p.text3),
                ),
              ],
            ),
          ),
          if (isSelf)
            Text('本机',
                style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: p.primary))
          else
            TextButton(
              onPressed: () => _revoke(d['id'] as String, d['name'] as String),
              style: TextButton.styleFrom(foregroundColor: p.danger),
              child: const Text('吊销'),
            ),
        ],
      ),
    );
  }
}
