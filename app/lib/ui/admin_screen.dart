import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/app_controller.dart';
import 'theme.dart';

/// 管理员登录：session + CSRF 登录表单。成功后 pop(true) 由打开方决定
/// 去向（我的页的门控入口会接着跳目标页）。429 = 登录限速（5 次失败后
/// 最长锁 15 分钟），UI 明示等待。
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
  bool _totpRequired = false;

  AppController get _app => context.read<AppController>();

  Future<void> _login() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await _app.loginAdmin(
          password: _password.text, totp: _totp.text.isEmpty ? null : _totp.text);
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } catch (e) {
      final msg = e.toString();
      if (!mounted) return;
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

  @override
  Widget build(BuildContext context) {
    final p = MdTheme.of(context);
    return Scaffold(
      backgroundColor: p.bg,
      appBar: AppBar(title: const Text('管理员登录')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
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
                  Text('管理员身份',
                      style: TextStyle(
                          fontSize: 14.5, fontWeight: FontWeight.w700, color: p.text)),
                  const SizedBox(height: 4),
                  Text('登录后解锁 回收站 · 工具 · 导入导出 · 设备管理',
                      style: TextStyle(fontSize: 12, color: p.text3)),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _password,
                    obscureText: true,
                    autofocus: true,
                    decoration: const InputDecoration(
                        labelText: '管理密码', border: OutlineInputBorder()),
                  ),
                  if (_totpRequired) ...[
                    const SizedBox(height: 12),
                    TextField(
                      controller: _totp,
                      keyboardType: TextInputType.number,
                      maxLength: 6,
                      decoration: const InputDecoration(
                          labelText: '两步验证码', border: OutlineInputBorder()),
                    ),
                  ],
                  const SizedBox(height: 12),
                  if (_error != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Text(_error!, style: TextStyle(color: p.danger, fontSize: 13)),
                    ),
                  FilledButton(
                    onPressed: _busy ? null : _login,
                    child: _busy
                        ? const SizedBox(
                            height: 20,
                            width: 20,
                            child: CircularProgressIndicator(strokeWidth: 2))
                        : const Text('登录'),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
