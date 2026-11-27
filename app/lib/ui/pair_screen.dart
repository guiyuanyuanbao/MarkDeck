import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/app_controller.dart';

/// First-run pairing: server URL + 6-digit code from the desktop admin page.
/// Validation rules mirror extension/src/options.ts (^https?:// + ^\d{6}$).
class PairScreen extends StatefulWidget {
  const PairScreen({super.key});

  @override
  State<PairScreen> createState() => _PairScreenState();
}

class _PairScreenState extends State<PairScreen> {
  final _server = TextEditingController();
  final _code = TextEditingController();
  bool _busy = false;
  String? _error;

  bool get _serverValid =>
      _server.text.trim().startsWith('http://') || _server.text.trim().startsWith('https://');
  bool get _codeValid => RegExp(r'^\d{6}$').hasMatch(_code.text.trim());

  Future<void> _pair() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await context.read<AppController>().pair(
            server: _server.text.trim(),
            code: _code.text.trim(),
            deviceName: 'Android',
          );
    } catch (e) {
      final msg = e.toString();
      setState(() {
        _error = msg.contains('401')
            ? '配对码无效或已过期'
            : msg.contains('429')
                ? '尝试次数过多，请稍候再试'
                : '连接失败：$msg';
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Icon(Icons.sync, size: 56, color: scheme.primary),
                const SizedBox(height: 12),
                Text(
                  'MarkDeck 配对',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
                const SizedBox(height: 6),
                Text(
                  '在桌面端管理页 → 设置 → 设备同步\n生成 6 位配对码，填入下方完成配对',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: scheme.outline),
                ),
                const SizedBox(height: 24),
                TextField(
                  controller: _server,
                  keyboardType: TextInputType.url,
                  onChanged: (_) => setState(() {}),
                  decoration: InputDecoration(
                    labelText: '服务器地址',
                    hintText: 'https://markdeck.example.com',
                    border: const OutlineInputBorder(),
                    errorText: _server.text.isEmpty || _serverValid ? null : '需以 http(s):// 开头',
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _code,
                  keyboardType: TextInputType.number,
                  maxLength: 6,
                  onChanged: (_) => setState(() {}),
                  decoration: InputDecoration(
                    labelText: '配对码',
                    hintText: '6 位数字',
                    border: const OutlineInputBorder(),
                    errorText: _code.text.isEmpty || _codeValid ? null : '6 位数字',
                  ),
                ),
                const SizedBox(height: 16),
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Text(_error!, style: TextStyle(color: scheme.error)),
                  ),
                FilledButton(
                  onPressed: (_busy || !_serverValid || !_codeValid) ? null : _pair,
                  child: _busy
                      ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Text('配对'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
