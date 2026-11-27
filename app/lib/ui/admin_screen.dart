import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/app_controller.dart';

/// Admin mode: password login (session + CSRF) unlocking session-only
/// routes — pair-code creation for other devices, device list/revoke,
/// TOTP, password change, proxy. Login rate-limit (5 fails → escalating
/// lock to 15 min) surfaces via 429 errors.
class AdminScreen extends StatefulWidget {
  const AdminScreen({super.key});

  @override
  State<AdminScreen> createState() => _AdminScreenState();
}

class _AdminScreenState extends State<AdminScreen> {
  final _password = TextEditingController();
  final _totp = TextEditingController();
  bool _busy = false;
  String? _error;
  bool _loggedIn = false;
  bool _totpRequired = false;
  List<Map<String, dynamic>>? _devices;

  AppController get _app => context.read<AppController>();

  Future<void> _login() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await _app.client.login(password: _password.text, totp: _totp.text.isEmpty ? null : _totp.text);
      setState(() {
        _loggedIn = true;
      });
      await _loadDevices();
    } catch (e) {
      final msg = e.toString();
      setState(() {
        if (msg.contains('401')) {
          _totpRequired = _totpRequired || msg.contains('totp');
          _error = '密码错误${_totpRequired ? '（需要两步验证码）' : ''}';
        } else if (msg.contains('429')) {
          _error = '尝试过多，已临时锁定（最长 15 分钟）';
        } else {
          _error = '登录失败：$msg';
        }
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _loadDevices() async {
    final r = await _app.client.get('/api/devices') as Map<String, dynamic>;
    setState(() {
      _devices = (r['devices'] as List? ?? []).cast<Map<String, dynamic>>();
    });
  }

  Future<void> _newPairCode() async {
    final name = TextEditingController(text: '新设备');
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('生成配对码'),
        content: TextField(controller: name, decoration: const InputDecoration(labelText: '设备名（可选）')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('生成')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      final r = await _app.client.post('/api/pair-code', body: {
        if (name.text.trim().isNotEmpty) 'deviceName': name.text.trim(),
      }) as Map<String, dynamic>;
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('配对码'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(r['code'] as String,
                  style: Theme.of(ctx).textTheme.displayMedium?.copyWith(fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              const Text('有效期 5 分钟，在目标设备上输入即可配对'),
            ],
          ),
          actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('完成'))],
        ),
      );
    } catch (e) {
      setState(() => _error = '生成失败：$e');
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
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('吊销')),
        ],
      ),
    );
    if (ok != true) return;
    await _app.client.delete('/api/devices/$id');
    await _loadDevices();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('管理员模式')),
      body: !_loggedIn ? _loginForm(scheme) : _adminPanel(scheme),
    );
  }

  Widget _loginForm(ColorScheme scheme) {
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextField(
            controller: _password,
            obscureText: true,
            autofocus: true,
            decoration: const InputDecoration(labelText: '管理密码', border: OutlineInputBorder()),
          ),
          if (_totpRequired) ...[
            const SizedBox(height: 12),
            TextField(
              controller: _totp,
              keyboardType: TextInputType.number,
              maxLength: 6,
              decoration: const InputDecoration(labelText: '两步验证码', border: OutlineInputBorder()),
            ),
          ],
          const SizedBox(height: 12),
          if (_error != null) Text(_error!, style: TextStyle(color: scheme.error)),
          const SizedBox(height: 8),
          FilledButton(
            onPressed: _busy ? null : _login,
            child: _busy
                ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text('登录'),
          ),
        ],
      ),
    );
  }

  Widget _adminPanel(ColorScheme scheme) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        FilledButton.icon(
          onPressed: _newPairCode,
          icon: const Icon(Icons.add_link),
          label: const Text('为其它设备生成配对码'),
        ),
        const SizedBox(height: 16),
        Text('设备列表', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        if (_devices == null)
          const Center(child: CircularProgressIndicator())
        else
          for (final d in _devices!)
            ListTile(
              leading: Icon(
                d['id'] == _app.deviceId ? Icons.phone_android : Icons.devices_other,
                color: scheme.primary,
              ),
              title: Text('${d['name']}'),
              subtitle: Text(
                d['online'] == true ? '在线' : '最后在线：${d['lastSeen'] ?? '-'}',
                style: TextStyle(color: d['online'] == true ? scheme.primary : scheme.outline),
              ),
              trailing: d['id'] == _app.deviceId
                  ? const Text('本机', style: TextStyle(fontWeight: FontWeight.bold))
                  : TextButton(
                      onPressed: () => _revoke(d['id'] as String, d['name'] as String),
                      child: const Text('吊销'),
                    ),
            ),
      ],
    );
  }
}
