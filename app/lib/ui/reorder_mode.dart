import 'dart:math' as math;

import 'package:drift/drift.dart' hide Column;
import 'package:flutter/material.dart';

import '../state/app_controller.dart';
import '../store/database.dart';
import 'theme.dart';
import 'widgets.dart';

/// 拖动排序模式 — web BookmarksView DnD 的手机版。当前文件夹的子项按
/// 纯 position 顺序列出（引擎 rank 序，不做文件夹优先分组——所见即同步
/// 真值）。长按行拖动；拖到 URL 行上/下半区 = 插到该行前/后（插入线），
/// 拖到文件夹卡片中心带 = 移入（含环检测），上下边缘带 = 前/后插入。
///
/// 镜像先行：位置/父节点在此重写，随后 journal 交出 LWW 凭证，由引擎
/// sweep 推 position-only ops（docs/protocol.md §排序同步；R1 路径）。
class ReorderMode extends StatefulWidget {
  const ReorderMode({
    super.key,
    required this.app,
    required this.folderId,
    required this.rows,
  });

  final AppController app;
  final String folderId; // 'root' = 书签栏合成根（服务端父为 ''）
  final List<Node> rows; // watchAllLive 的全量行（算子链/桶用）

  @override
  State<ReorderMode> createState() => _ReorderModeState();
}

class _ReorderModeState extends State<ReorderMode> {
  final _scroll = ScrollController();
  final _listKey = GlobalKey();
  final _rowKeys = <String, GlobalKey>{};

  String? _dragId;
  String? _hoverId;
  bool _hoverInside = false; // 文件夹中心带：移入
  bool _hoverBefore = true; // 插入线在该行上缘（false = 下缘）

  String get _serverParent => widget.folderId == 'root' ? '' : widget.folderId;

  /// 引擎 rank 序：position 升序，createdAt 决胜（LocalTreeSource.load 同款）
  List<Node> get _children {
    final kids =
        widget.rows.where((r) => r.parentId == _serverParent).toList()
          ..sort((a, b) {
            final c = a.position.compareTo(b.position);
            return c != 0 ? c : a.createdAt.compareTo(b.createdAt);
          });
    return kids;
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = MdTheme.of(context);
    final kids = _children;
    return ListView.builder(
      key: _listKey,
      controller: _scroll,
      padding: const EdgeInsets.symmetric(vertical: 4),
      itemCount: kids.length,
      itemBuilder: (context, i) => _dragRow(p, kids[i]),
    );
  }

  // ---- row ----

  Widget _dragRow(MdPalette p, Node n) {
    _rowKeys[n.id] ??= GlobalKey();
    final key = _rowKeys[n.id]!;
    return DragTarget<String>(
      onWillAcceptWithDetails: (details) => _canAccept(details.data, n),
      onMove: (details) => _trackHover(n, details.offset),
      onLeave: (_) => _clearHover(n.id),
      onAcceptWithDetails: (details) => _dropOn(n, details.offset),
      builder: (context, candidate, _) {
        final showLine = _hoverId == n.id && !_hoverInside;
        final showInside = _hoverId == n.id && _hoverInside;
        return Column(
          key: key,
          children: [
            if (showLine && _hoverBefore) _dropLine(p),
            LongPressDraggable<String>(
              data: n.id,
              dragAnchorStrategy: pointerDragAnchorStrategy,
              onDragStarted: () => setState(() => _dragId = n.id),
              onDragUpdate: (details) => _autoScroll(details.globalPosition),
              onDragEnd: (_) => _clearDrag(),
              onDraggableCanceled: (_, _) => _clearDrag(),
              feedback: _dragFeedback(p, n),
              childWhenDragging: Opacity(opacity: 0.3, child: _rowContent(p, n)),
              child: _rowContent(p, n,
                  folderTarget: showInside,
                  dimmed: _dragId != null && _dragId != n.id),
            ),
            if (showLine && !_hoverBefore) _dropLine(p),
          ],
        );
      },
    );
  }

  Widget _rowContent(MdPalette p, Node n, {bool folderTarget = false, bool dimmed = false}) {
    final isFolder = n.type == 'folder';
    return Container(
      color: folderTarget ? p.primarySoft : p.surface,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Opacity(
        opacity: dimmed ? 0.55 : 1,
        child: Row(
          children: [
            SizedBox(
              width: 36,
              child: isFolder
                  ? Container(
                      width: 32,
                      height: 32,
                      decoration: BoxDecoration(
                        color: p.primarySoft,
                        borderRadius: BorderRadius.circular(9),
                      ),
                      child: Icon(Icons.folder_rounded, size: 18, color: p.primary),
                    )
                  : BookmarkAvatar(url: n.url ?? '', title: n.title, size: 32),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: Text(n.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                                fontSize: 14,
                                fontWeight: FontWeight.w500,
                                color: p.text)),
                      ),
                      if (n.favorite)
                        Padding(
                          padding: const EdgeInsets.only(left: 4),
                          child: Icon(Icons.star, size: 13, color: p.warning),
                        ),
                    ],
                  ),
                  if (isFolder)
                    Text(folderTarget ? '松手移入此文件夹' : '文件夹',
                        style: TextStyle(
                            fontSize: 12,
                            color: folderTarget ? p.primary : p.text3))
                  else
                    Text(n.url ?? '',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 12, color: p.text3)),
                ],
              ),
            ),
            Icon(Icons.drag_indicator, size: 18, color: p.text3),
          ],
        ),
      ),
    );
  }

  Widget _dragFeedback(MdPalette p, Node n) {
    final width = math.min(MediaQuery.of(context).size.width - 48, 360.0);
    return Material(
      elevation: 6,
      borderRadius: BorderRadius.circular(12),
      color: p.surface,
      child: SizedBox(
        width: width,
        child: Row(
          children: [
            const SizedBox(width: 6),
            SizedBox(
              width: 32,
              child: n.type == 'folder'
                  ? Icon(Icons.folder_rounded, size: 20, color: p.primary)
                  : BookmarkAvatar(url: n.url ?? '', title: n.title, size: 28),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(n.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: p.text)),
            ),
            const Icon(Icons.drag_indicator, size: 18, color: Colors.grey),
            const SizedBox(width: 6),
          ],
        ),
      ),
    );
  }

  Widget _dropLine(MdPalette p) {
    return Container(
      height: 2.5,
      margin: const EdgeInsets.symmetric(horizontal: 12),
      color: p.primary,
    );
  }

  // ---- hover / drop geometry ----

  bool _canAccept(String draggedId, Node target) {
    if (draggedId == target.id) return false;
    if (target.type != 'folder') return true;
    // 拖入文件夹：目标文件夹不能是被拖节点自身或其子孙（环检测）
    return !_inSubtree(target.id, draggedId);
  }

  /// targetFolderId 是否在 draggedId 的子树内（含自身）
  bool _inSubtree(String draggedId, String targetFolderId) {
    final byId = {for (final r in widget.rows) r.id: r};
    String? cur = targetFolderId;
    while (cur != null && cur.isNotEmpty) {
      if (cur == draggedId) return true;
      cur = byId[cur]?.parentId;
    }
    return false;
  }

  void _trackHover(Node n, Offset global) {
    final box = _rowBox(n.id);
    if (box == null || !box.hasSize) return;
    final top = box.localToGlobal(Offset.zero).dy;
    final h = box.size.height;
    final dy = global.dy;
    bool inside = false;
    bool before;
    if (n.type == 'folder') {
      final upper = top + h * 0.25;
      final lower = top + h * 0.75;
      if (dy < upper) {
        before = true;
      } else if (dy > lower) {
        before = false;
      } else {
        inside = true;
        before = false;
      }
    } else {
      before = dy < top + h / 2;
    }
    if (_hoverId != n.id || _hoverInside != inside || _hoverBefore != before) {
      setState(() {
        _hoverId = n.id;
        _hoverInside = inside;
        _hoverBefore = before;
      });
    }
    _autoScroll(global);
  }

  void _clearHover(String id) {
    if (_hoverId == id) {
      setState(() {
        _hoverId = null;
        _hoverInside = false;
      });
    }
  }

  void _clearDrag() {
    setState(() {
      _dragId = null;
      _hoverId = null;
      _hoverInside = false;
    });
  }

  void _dropOn(Node target, Offset global) {
    final dragged = _dragId;
    _clearDrag();
    if (dragged == null) return;
    final box = _rowBox(target.id);
    if (box == null || !box.hasSize) return;
    final top = box.localToGlobal(Offset.zero).dy;
    final h = box.size.height;
    final dy = global.dy;
    if (target.type == 'folder') {
      final upper = top + h * 0.25;
      final lower = top + h * 0.75;
      if (dy >= upper && dy <= lower) {
        _moveInto(dragged, target.id);
        return;
      }
      _insertRelative(dragged, target.id, before: dy < upper);
    } else {
      _insertRelative(dragged, target.id, before: dy < top + h / 2);
    }
  }

  // ---- mutations (mirror-first, then journal) ----

  /// 同级插行：从纯位置序列摘出被拖项，插到目标前/后，整桶重写 1..n
  Future<void> _insertRelative(String draggedId, String targetId, {required bool before}) async {
    final seq = _children;
    final from = seq.indexWhere((r) => r.id == draggedId);
    if (from < 0) return;
    final dragged = seq.removeAt(from);
    var ti = seq.indexWhere((r) => r.id == targetId);
    if (ti < 0) return;
    seq.insert(before ? ti : ti + 1, dragged);
    await _writeOrder(seq, draggedId);
  }

  /// 拖入文件夹：落到目标桶尾部（MaxPosition+1），改父 + 写位置 + journal
  Future<void> _moveInto(String draggedId, String targetFolderId) async {
    final siblings = widget.rows
        .where((r) => r.parentId == targetFolderId && r.id != draggedId)
        .toList()
          ..sort((a, b) {
            final c = a.position.compareTo(b.position);
            return c != 0 ? c : a.createdAt.compareTo(b.createdAt);
          });
    final pos = siblings.isEmpty ? 1.0 : siblings.last.position + 1;
    await (widget.app.db.update(widget.app.db.nodes)..where((r) => r.id.equals(draggedId)))
        .write(NodesCompanion(
      parentId: Value(targetFolderId),
      position: Value(pos),
    ));
    await widget.app.driver.journalTouch(draggedId);
    if (mounted) setState(() {}); // 反馈：该行离开当前桶
  }

  /// 整桶重写为 1..n（与服务端 Store.Reorder 同语义）；被拖节点 journal
  /// 作为 sweep 凭证（R1 路径），父桶 reordered touch 双保险。
  Future<void> _writeOrder(List<Node> seq, String draggedId) async {
    for (var i = 0; i < seq.length; i++) {
      final pos = (i + 1).toDouble();
      if ((seq[i].position - pos).abs() < 1e-9) continue;
      await (widget.app.db.update(widget.app.db.nodes)..where((r) => r.id.equals(seq[i].id)))
          .write(NodesCompanion(position: Value(pos)));
    }
    await widget.app.driver.journalTouch(draggedId);
    await widget.app.driver
        .journalReorder(_serverParent.isEmpty ? 'root' : _serverParent);
  }

  // ---- helpers ----

  RenderBox? _rowBox(String id) {
    final key = _rowKeys[id];
    if (key == null) return null;
    final ctx = key.currentContext;
    return ctx?.findRenderObject() as RenderBox?;
  }

  /// 拖近列表上下边缘 64px 时渐进滚动，保证长列表可达折叠项
  void _autoScroll(Offset global) {
    final box = _listKey.currentContext?.findRenderObject() as RenderBox?;
    if (box == null || !box.hasSize || !_scroll.hasClients) return;
    const edge = 64.0;
    const speed = 16.0;
    final top = box.localToGlobal(Offset.zero).dy;
    final bottom = top + box.size.height;
    if (global.dy < top + edge) {
      final t = 1 - (global.dy - top) / edge;
      _scroll.jumpTo(math.max(0.0, _scroll.offset - speed * (0.3 + t)));
    } else if (global.dy > bottom - edge) {
      final t = 1 - (bottom - global.dy) / edge;
      _scroll.jumpTo(math.min(_scroll.position.maxScrollExtent,
          _scroll.offset + speed * (0.3 + t)));
    }
  }
}
