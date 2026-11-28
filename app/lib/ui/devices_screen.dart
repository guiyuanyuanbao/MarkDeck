import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/app_controller.dart';
import 'theme.dart';

/// 配对设备 (web SettingsDevices): pair-code generation + device list with
/// revoke. Deep-linked from the utility sheet.
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

  AppController get _app => context.read<AppController>();

  @override
  void initState() {
    super.initState();
    _loadDevices();
  }

  Future<void> _loadDevices() async {
    try {
      final r = await _app.client.get('/api/devices') as Map<String, dynamic>;
      setState(() => _devices = (r['devices'] as List? ?? []).cast<Map<String, dynamic>>());
    } catch (_) {
      setState(() => _devices = []);
    }
  }

  Future<void> _newPairCode() async {
    setState(() => _busyCode = true);
    try {
      final r = await _app.client.post('/api/pair-code', body: {
        if (_name.text.trim().isNotEmpty) 'deviceName': _name.text.trim(),
      }) as Map<String, dynamic>;
      setState(() => _code = r['code'] as String);
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
    await _app.client.delete('/api/devices/$id');
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
          // ---- pair-code card ----
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
          if (_devices == null)
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
