import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../state/app_controller.dart';
import 'theme.dart';

/// 导入导出 screen (web ImportView): import HTML with merge/standalone modes
/// + export HTML/JSON cards. Device-token routes; export downloads bytes.
class ImportScreen extends StatefulWidget {
  const ImportScreen({super.key});

  @override
  State<ImportScreen> createState() => _ImportScreenState();
}

class _ImportScreenState extends State<ImportScreen> {
  bool _merge = true;
  final _folderName = TextEditingController();
  bool _busy = false;
  String? _done;

  AppController get _app => context.read<AppController>();

  @override
  Widget build(BuildContext context) {
    final p = MdTheme.of(context);
    return Scaffold(
      backgroundColor: p.bg,
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text('导入 / 导出',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: p.text)),
            Text('从浏览器书签 HTML 恢复，或将全部书签带走到任何地方',
                style: TextStyle(fontSize: 13, color: p.text2)),
            const SizedBox(height: 16),
            _section(p, '导入书签 HTML', _importCard(p)),
            const SizedBox(height: 16),
            _section(p, '导出', _exportCards(p)),
          ],
        ),
      ),
    );
  }

  Widget _section(MdPalette p, String title, Widget child) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: p.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(title,
              style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700, color: p.text)),
          const SizedBox(height: 12),
          child,
        ],
      ),
    );
  }

  Widget _importCard(MdPalette p) {
    // The phone cannot open a system file picker without extra plugins, so
    // import goes through paste-HTML: user exports HTML on desktop / picks
    // it in any file app and shares its content here.
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: _modeCard(p, Icons.merge_type, '合并导入', '去重后并入现有书签', _merge,
                  () => setState(() => _merge = true)),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _modeCard(p, Icons.create_new_folder_outlined, '独立文件夹',
                  '导入到以文件名命名的新文件夹', !_merge, () => setState(() => _merge = false)),
            ),
          ],
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _folderName,
          enabled: !_merge,
          decoration: InputDecoration(
            labelText: '目标文件夹名',
            hintText: '默认「导入的书签」',
          ),
        ),
        const SizedBox(height: 12),
        OutlinedButton.icon(
          onPressed: _busy ? null : _pasteImport,
          icon: const Icon(Icons.content_paste),
          label: const Text('粘贴 HTML 内容导入'),
        ),
        if (_busy) ...[
          const SizedBox(height: 12),
          const LinearProgressIndicator(),
        ],
        if (_done != null) ...[
          const SizedBox(height: 12),
          Row(children: [
            Icon(Icons.check_circle, color: p.success, size: 18),
            const SizedBox(width: 6),
            Expanded(child: Text(_done!, style: TextStyle(color: p.success, fontSize: 13))),
          ]),
        ],
      ],
    );
  }

  Widget _modeCard(MdPalette p, IconData icon, String title, String sub, bool selected,
      VoidCallback onTap) {
    return InkWell(
      borderRadius: BorderRadius.circular(10),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: selected ? p.primarySoft : p.bg,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: selected ? p.primary : p.border, width: selected ? 1.5 : 1),
        ),
        child: Column(
          children: [
            Icon(icon, size: 20, color: selected ? p.primary : p.text2),
            const SizedBox(height: 4),
            Text(title,
                style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                    color: selected ? p.primary : p.text)),
            Text(sub, style: TextStyle(fontSize: 10.5, color: p.text3), textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }

  Future<void> _pasteImport() async {
    final messenger = ScaffoldMessenger.of(context);
    final data = await Clipboard.getData('text/plain');
    var html = data?.text ?? '';
    if (html.trim().isEmpty) {
      // no clipboard HTML: let the user paste in a dialog
      final c = TextEditingController();
      if (!mounted) return;
      final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('粘贴书签 HTML'),
          content: SizedBox(
            width: 320,
            child: TextField(
              controller: c,
              maxLines: 8,
              decoration: const InputDecoration(hintText: '<!DOCTYPE NETSCAPE-...>'),
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('导入')),
          ],
        ),
      );
      if (ok != true) return;
      html = c.text;
    }
    if (html.trim().isEmpty) return;
    if (!mounted) return;
    setState(() => _busy = true);
    try {
      final r = await _app.client.post('/api/import/html', body: {
        'html': html,
        if (!_merge) 'folderName': _folderName.text.trim().isNotEmpty ? _folderName.text.trim() : '导入的书签',
      }) as Map<String, dynamic>;
      setState(() {
        _done = '导入成功：新增 ${r['added'] ?? 0}，跳过重复 ${r['skipped'] ?? 0}';
      });
      await _app.driver.reconcile('import');
    } catch (e) {
      setState(() => _done = null);
      messenger.showSnackBar(SnackBar(content: Text('导入失败：$e')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _exportCards(MdPalette p) {
    return Column(
      children: [
        _exportCard(p, 'H', p.primarySoft, p.primary, '导出 HTML',
            'Netscape 格式，可导入 Chrome/Edge/Firefox', 'https', 'html'),
        const SizedBox(height: 8),
        _exportCard(p, '{}', p.dangerSoft, p.danger, '导出 JSON',
            '完整结构化数据，含标签与回收站', 'data_object', 'json'),
      ],
    );
  }

  Widget _exportCard(MdPalette p, String badge, Color badgeBg, Color badgeFg, String title,
      String sub, String iconKey, String ext) {
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: () => _doExport(badgeFg, title, ext),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: p.bg,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: p.border),
        ),
        child: Row(
          children: [
            Container(
              width: 40,
              height: 40,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: badgeBg,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Text(badge,
                  style: TextStyle(
                      color: badgeFg, fontWeight: FontWeight.w800, fontSize: 14)),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title,
                      style: TextStyle(
                          fontSize: 14, fontWeight: FontWeight.w700, color: p.text)),
                  Text(sub, style: TextStyle(fontSize: 12, color: p.text3)),
                ],
              ),
            ),
            Icon(Icons.chevron_right, color: p.text3),
          ],
        ),
      ),
    );
  }

  Future<void> _doExport(Color color, String title, String ext) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      final resp = await _app.client.getBytes('/api/export/$ext');
      await Clipboard.setData(ClipboardData(text: resp.body));
      messenger.showSnackBar(SnackBar(
        content: Text('$title 已复制到剪贴板（${resp.body.length} 字符）'),
      ));
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('导出失败：$e')));
    }
  }

}
