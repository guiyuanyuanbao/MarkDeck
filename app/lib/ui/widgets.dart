import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/app_controller.dart';
import '../store/database.dart' hide BaseEntry;
import 'theme.dart';

/// BookmarkAvatar parity (web/src/components/BookmarkAvatar.vue): favicon
/// from /api/favicon/{host} with a per-host letter-gradient fallback picked
/// by hash(url|title). List rows and grid cards render identically.
class BookmarkAvatar extends StatefulWidget {
  const BookmarkAvatar({super.key, required this.url, required this.title, this.size = 22});

  final String url;
  final String title;
  final double size;

  @override
  State<BookmarkAvatar> createState() => _BookmarkAvatarState();
}

class _BookmarkAvatarState extends State<BookmarkAvatar> {
  static final _failed = <String>{};

  String? get _host {
    if (widget.url.isEmpty) return null;
    try {
      final h = Uri.parse(widget.url).host;
      return h.isEmpty ? null : h;
    } on FormatException {
      return null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final host = _host;
    final size = widget.size;
    if (host == null || _failed.contains(host)) {
      // letter gradient fallback
      final colors = MdTheme.avatarColors(widget.url, widget.title);
      final letter = (widget.title.isNotEmpty ? widget.title[0] : '?').toUpperCase();
      return Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: colors,
          ),
          borderRadius: BorderRadius.circular(size * 0.3),
        ),
        alignment: Alignment.center,
        child: Text(
          letter,
          style: TextStyle(
            color: Colors.white,
            fontSize: size * 0.45,
            fontWeight: FontWeight.w700,
          ),
        ),
      );
    }
    final server = context.read<AppController>().serverUrl ?? '';
    return ClipRRect(
      borderRadius: BorderRadius.circular(size * 0.3),
      child: Image.network(
        '$server/api/favicon/$host',
        width: size,
        height: size,
        fit: BoxFit.cover,
        errorBuilder: (_, _, _) {
          _failed.add(host);
          // schedule rebuild to show the fallback
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (mounted) setState(() {});
          });
          return SizedBox(width: size, height: size);
        },
      ),
    );
  }
}

/// Shared UI helpers kept from v1: folder picker + tag prompt + codecs.

/// Folder picker dialog: walk the mirror tree, return the picked folder id
/// ('root' = bar bucket) or null when cancelled.
Future<String?> pickFolder(
  BuildContext context,
  dynamic db, {
  Set<String> excludeIds = const {},
}) async {
  return showDialog<String>(
    context: context,
    builder: (ctx) => _FolderPicker(db: db, excludeIds: excludeIds),
  );
}

class _FolderPicker extends StatefulWidget {
  const _FolderPicker({required this.db, required this.excludeIds});

  final dynamic db;
  final Set<String> excludeIds;

  @override
  State<_FolderPicker> createState() => _FolderPickerState();
}

class _FolderPickerState extends State<_FolderPicker> {
  String _current = 'root';

  /// root..current 的层级链（用于对话框内的路径面包屑）
  List<Node> _crumbChain(List rows) {
    final chain = <Node>[];
    var cur = rows.where((r) => r.id == _current).firstOrNull;
    while (cur != null) {
      chain.insert(0, cur);
      cur = rows.where((r) => r.id == cur!.parentId).firstOrNull;
    }
    return chain;
  }

  Widget _crumbChip(MdPalette p, String label,
      {required bool active, VoidCallback? onTap}) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 3),
      child: Material(
        color: active ? p.primarySoft : p.bg,
        borderRadius: BorderRadius.circular(999),
        child: InkWell(
          borderRadius: BorderRadius.circular(999),
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(999),
              border: Border.all(color: active ? p.primary : p.border),
            ),
            child: Text(label,
                style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: active ? FontWeight.w700 : FontWeight.w500,
                    color: active ? p.primary : p.text2)),
          ),
        ),
      ),
    );
  }

  Widget _pickerRow(MdPalette p, IconData icon, String title,
      {VoidCallback? onTap, bool isCurrent = false}) {
    return ListTile(
      leading: Container(
        width: 36,
        height: 36,
        decoration: BoxDecoration(
          color: isCurrent ? p.primary : p.primarySoft,
          borderRadius: BorderRadius.circular(10),
        ),
        child: Icon(icon, size: 18, color: isCurrent ? Colors.white : p.primary),
      ),
      title: Text(title,
          style: TextStyle(
              fontSize: 14,
              fontWeight: isCurrent ? FontWeight.w700 : FontWeight.w500,
              color: p.text)),
      trailing: isCurrent
          ? Icon(Icons.check_circle, size: 18, color: p.primary)
          : Icon(Icons.chevron_right, size: 18, color: p.text3),
      onTap: onTap,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      tileColor: isCurrent ? p.primarySoft : null,
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = MdTheme.of(context);
    return AlertDialog(
      title: const Text('移动到…'),
      content: SizedBox(
        width: 320,
        height: 380,
        child: StreamBuilder(
          stream: widget.db.watchAllLive(),
          builder: (context, snap) {
            final rows = (snap.data as List?) ?? const [];
            final serverParent = _current == 'root' ? '' : _current;
            final folders = rows
                .where((r) => r.type == 'folder' && r.parentId == serverParent)
                .toList()
              ..sort((a, b) {
                final c = a.position.compareTo(b.position);
                return c != 0 ? c : a.createdAt.compareTo(b.createdAt);
              });
            final chain = _crumbChain(rows);
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // 当前路径面包屑：用户随时知道自己浏览到哪一层
                SizedBox(
                  height: 34,
                  child: ListView(
                    scrollDirection: Axis.horizontal,
                    shrinkWrap: true,
                    children: [
                      _crumbChip(p, '书签栏',
                          active: _current == 'root',
                          onTap: _current == 'root'
                              ? null
                              : () => setState(() => _current = 'root')),
                      for (final c in chain) ...[
                        Icon(Icons.chevron_right, size: 13, color: p.text3),
                        _crumbChip(p, c.title,
                            active: c.id == _current,
                            onTap: c.id == _current
                                ? null
                                : () => setState(() => _current = c.id)),
                      ],
                    ],
                  ),
                ),
                const SizedBox(height: 4),
                Divider(height: 1, color: p.border),
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    children: [
                      if (_current != 'root')
                        _pickerRow(p, Icons.arrow_upward, '上一级',
                            onTap: () => setState(() {
                                  final parent = rows
                                      .where((r) => r.id == _current)
                                      .firstOrNull;
                                  _current = parent == null
                                      ? 'root'
                                      : (parent.parentId.isEmpty
                                          ? 'root'
                                          : parent.parentId);
                                })),
                      for (final f in folders)
                        if (!widget.excludeIds.contains(f.id))
                          _pickerRow(p, Icons.folder_rounded, f.title,
                              onTap: () => setState(() => _current = f.id)),
                      if (folders
                          .where((f) => !widget.excludeIds.contains(f.id))
                          .isEmpty &&
                          _current != 'root')
                        Padding(
                          padding: const EdgeInsets.all(16),
                          child: Text('此文件夹下没有子文件夹了',
                              style: TextStyle(fontSize: 12.5, color: p.text3)),
                        ),
                    ],
                  ),
                ),
              ],
            );
          },
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(
            onPressed: () => Navigator.pop(context, _current), child: const Text('移到这里')),
      ],
    );
  }
}

/// Tag input prompt: comma-separated, trimmed, deduped. Null on cancel.
Future<List<String>?> promptTags(BuildContext context) async {
  final controller = TextEditingController();
  final result = await showDialog<List<String>>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('标签'),
      content: TextField(
        controller: controller,
        autofocus: true,
        decoration: const InputDecoration(
          labelText: '逗号分隔，如: 工作, 文档',
          border: OutlineInputBorder(),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
        FilledButton(
          onPressed: () {
            final tags = controller.text
                .split(',')
                .map((t) => t.trim())
                .where((t) => t.isNotEmpty)
                .toSet()
                .toList();
            Navigator.pop(ctx, tags);
          },
          child: const Text('确定'),
        ),
      ],
    ),
  );
  return result;
}

/// 配色主题圆点（web 头部主题切换的手机版）。选中态由 [selected] 控制，
/// 点击只负责回调，不做导航 —— 放置方（我的页）决定后续行为。
class ThemeDot extends StatelessWidget {
  const ThemeDot({
    super.key,
    required this.id,
    required this.label,
    required this.palette,
    required this.selected,
  });

  final String id;
  final String label;
  final MdPalette palette;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final app = context.read<AppController>();
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: () => app.setTheme(id),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Column(
          children: [
            Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [palette.primary, palette.loginBg1],
                ),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(
                  color: selected ? palette.primary : palette.border,
                  width: selected ? 2 : 1,
                ),
              ),
            ),
            const SizedBox(height: 4),
            Text(label,
                style: TextStyle(
                    fontSize: 11,
                    color: selected ? palette.primary : palette.text2,
                    fontWeight: selected ? FontWeight.w700 : FontWeight.w500)),
          ],
        ),
      ),
    );
  }
}
