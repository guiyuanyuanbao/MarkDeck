import 'package:drift/drift.dart' hide Column;
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../state/app_controller.dart';
import '../store/database.dart';
import 'edit_sheet.dart' show showEditSheet, showCreateFolder, tagsFromJson, tagsToJson;
import 'reorder_mode.dart';
import 'theme.dart';
import 'widgets.dart';

/// 书签 — file-manager body mirroring web BookmarksView: breadcrumbs +
/// title/meta, toolbar (search / tag filter / view switch / 新书签),
/// selection batch bar, list or grid content. Grid mode is the phone-first
/// default (web defaults to list on desktop; a phone benefits from icons).
class BrowseScreen extends StatefulWidget {
  const BrowseScreen({super.key});

  @override
  State<BrowseScreen> createState() => _BrowseScreenState();
}

enum _ViewMode { list, grid }

class _BrowseScreenState extends State<BrowseScreen> {
  String _folderId = 'root'; // synthetic bar root in the mirror
  final _selected = <String>{};
  bool _selecting = false;
  bool _reordering = false;
  final _drag = DragOrderModel();
  final _reorderScroll = ScrollController();
  _ViewMode _view = _ViewMode.grid;
  String _tagFilter = '';
  bool _searchOpen = false;
  final _query = TextEditingController();

  @override
  void initState() {
    super.initState();
    _drag.scroll = _reorderScroll;
  }

  @override
  void dispose() {
    _reorderScroll.dispose();
    _drag.dispose();
    _query.dispose();
    super.dispose();
  }

  AppController get _app => context.read<AppController>();
  AppDatabase get _db => _app.db;

  @override
  Widget build(BuildContext context) {
    final p = MdTheme.of(context);
    // Bare tab page (no Scaffold of its own): the shell provides the bottom
    // nav, this SafeArea keeps the header clear of the status bar. PopScope
    // lets the SYSTEM back gesture/button exit in-page modes (排序/选择)
    // instead of leaving the app — no custom swipe implementation.
    return PopScope(
      canPop: !_reordering && !_selecting,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        setState(() {
          if (_reordering) {
            _reordering = false;
            _drag.end();
          } else {
            _exitSelect();
          }
        });
      },
      child: SafeArea(
        bottom: false,
        child: StreamBuilder<List<Node>>(
          stream: _db.watchAllLive(),
          builder: (context, snap) {
            final rows = snap.data ?? const <Node>[];
            // 浏览中的文件夹被任意端删除后，镜像不再有该行：自动回根，
            // 否则面包屑断链、用户被困在空页面（切 Tab 也回不去）
            if (_folderId != 'root' &&
                !_reordering &&
                !rows.any((r) => r.id == _folderId)) {
              WidgetsBinding.instance.addPostFrameCallback((_) {
                if (mounted && _folderId != 'root') {
                  setState(() => _folderId = 'root');
                }
              });
            }
            final children = _filtered(rows);
            return Column(
              children: [
                _head(p, rows, children.length),
                if (_selecting) _batchBar(p),
                Expanded(
                  child: snap.hasData
                      ? (children.isEmpty
                          ? _empty(p)
                          : (_view == _ViewMode.grid
                              ? _grid(p, children, rows)
                              : _list(p, children, rows)))
                      : Center(child: CircularProgressIndicator(color: p.primary)),
                ),
                if (_reordering) _reorderBarSlim(p),
              ],
            );
          },
        ),
      ),
    );
  }
  // ---- data ----

  List<Node> _filtered(List<Node> rows) {
    final serverParent = _folderId == 'root' ? '' : _folderId;
    // 顺序真值 = 纯 position 序（与网页 BookmarksView / 引擎 rank 一致，
    // 文件夹不提前分组——排序模式所见即所同步）。md-others 是服务端管理
    // 的固定尾项（pos=9999/10001），强制排最后且不参与位置重写。
    final othersId = _app.driver.othersId;
    var kids = rows.where((r) => r.parentId == serverParent).toList()
      ..sort((a, b) {
        final oa = a.id == othersId ? 1 : 0;
        final ob = b.id == othersId ? 1 : 0;
        if (oa != ob) return oa - ob;
        final c = a.position.compareTo(b.position);
        return c != 0 ? c : a.createdAt.compareTo(b.createdAt);
      });
    final q = _query.text.trim().toLowerCase();
    if (q.isNotEmpty) {
      kids = kids
          .where((r) =>
              r.title.toLowerCase().contains(q) ||
              (r.url ?? '').toLowerCase().contains(q) ||
              r.note.toLowerCase().contains(q))
          .toList();
    }
    if (_tagFilter.isNotEmpty) {
      kids = kids.where((r) => tagsFromJson(r.tags).contains(_tagFilter)).toList();
    }
    return kids;
  }

  String get _folderName {
    if (_folderId == 'root') return '书签栏';
    final name = _titleCache[_folderId];
    return name ?? '文件夹';
  }

  final _titleCache = <String, String>{};

  // ---- header block (breadcrumbs + title + toolbar) ----

  Widget _head(MdPalette p, List<Node> rows, int count) {
    // refresh title cache from the full row set
    for (final r in rows) {
      if (r.type == 'folder') _titleCache[r.id] = r.title;
    }
    final crumbs = _crumbs(rows);
    return Container(
      color: p.surface,
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // breadcrumbs — only past the root; at root the title below says
          // the same thing and the duplicate line reads as a bug
          if (crumbs.length > 1)
            SizedBox(
              height: 24,
              child: ListView(
                scrollDirection: Axis.horizontal,
                children: [
                  for (var i = 0; i < crumbs.length; i++) ...[
                    if (i > 0)
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                        child: Text('/', style: TextStyle(color: p.text3, fontSize: 13)),
                      ),
                    InkWell(
                      onTap: i == crumbs.length - 1
                          ? null
                          : () => setState(() {
                                _folderId = crumbs[i].$1;
                                _exitSelect();
                              }),
                      child: Text(
                        crumbs[i].$2,
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight:
                              i == crumbs.length - 1 ? FontWeight.w700 : FontWeight.w500,
                          color: i == crumbs.length - 1 ? p.text : p.text2,
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          if (crumbs.length > 1) const SizedBox(height: 6),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(_folderName,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                            fontSize: 20, fontWeight: FontWeight.w700, color: p.text)),
                    Text('$count 项', style: TextStyle(fontSize: 12, color: p.text3)),
                  ],
                ),
              ),
              // 排序模式下锁定其余工具（会改变可见集合，破坏拖拽映射）
              _iconBtn(p, Icons.search, _searchOpen ? '关闭搜索' : '搜索',
                  active: _searchOpen,
                  onTap: _reordering ? null : () => setState(() => _searchOpen = !_searchOpen)),
              const SizedBox(width: 6),
              _iconBtn(
                p,
                _tagFilter.isEmpty ? Icons.label_outline : Icons.label,
                '按标签筛选',
                active: _tagFilter.isNotEmpty,
                onTap: _reordering ? null : () => _pickTag(rows),
              ),
              const SizedBox(width: 6),
              _iconBtn(
                p,
                _view == _ViewMode.grid ? Icons.view_list_outlined : Icons.grid_view,
                _view == _ViewMode.grid ? '列表视图' : '图标视图',
                onTap: _reordering
                    ? null
                    : () => setState(
                        () => _view = _view == _ViewMode.grid ? _ViewMode.list : _ViewMode.grid),
              ),
              const SizedBox(width: 6),
              _iconBtn(p, Icons.swap_vert, _reordering ? '退出排序' : '拖动排序',
                  active: _reordering, onTap: () => _toggleReorder(rows)),
            ],
          ),
          if (!_reordering && _searchOpen) ...[
            const SizedBox(height: 8),
            TextField(
              controller: _query,
              autofocus: true,
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(
                isDense: true,
                prefixIcon: const Icon(Icons.search, size: 18),
                hintText: '搜索标题 / URL / 备注',
                suffixIcon: _query.text.isEmpty
                    ? null
                    : IconButton(
                        icon: const Icon(Icons.close, size: 18),
                        onPressed: () => setState(() => _query.clear()),
                      ),
              ),
            ),
          ],
          if (_tagFilter.isNotEmpty) ...[
            const SizedBox(height: 8),
            Wrap(
              spacing: 6,
              children: [
                Chip(
                  label: Text(_tagFilter),
                  onDeleted: () => setState(() => _tagFilter = ''),
                  deleteIcon: const Icon(Icons.close, size: 16),
                ),
              ],
            ),
          ],
          if (!_reordering) ...[
            const SizedBox(height: 10),
            Row(
              children: [
                FilledButton.icon(
                  onPressed: () => showEditSheet(
                    context,
                    _db,
                    parentId: _folderId == 'root' ? '' : _folderId,
                  ),
                  icon: const Icon(Icons.add, size: 18),
                  label: const Text('新书签'),
                ),
                const SizedBox(width: 8),
                OutlinedButton.icon(
                  onPressed: () => showCreateFolder(context, _db, _folderId),
                  icon: const Icon(Icons.create_new_folder_outlined, size: 18),
                  label: const Text('新文件夹'),
                ),
                const Spacer(),
                if (_selecting)
                  TextButton(onPressed: _exitSelect, child: const Text('取消'))
                else
                  TextButton(
                    onPressed: () => setState(() => _selecting = true),
                    child: const Text('选择'),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  List<(String, String)> _crumbs(List<Node> rows) {
    if (_folderId == 'root') return [('root', '书签栏')];
    final chain = <(String, String)>[];
    var cur = rows.where((r) => r.id == _folderId).firstOrNull;
    while (cur != null) {
      chain.insert(0, (cur.id, cur.title));
      cur = rows.where((r) => r.id == cur!.parentId).firstOrNull;
    }
    return [('root', '书签栏'), ...chain];
  }

  // ---- reorder mode (原地排序：当前布局直接可拖，底部窄栏提示) ----

  void _toggleReorder(List<Node> rows) {
    if (_reordering) {
      setState(() {
        _reordering = false;
        _drag.end();
      });
      return;
    }
    if (_searchOpen || _query.text.trim().isNotEmpty || _tagFilter.isNotEmpty) {
      _snack('请先清除搜索或标签筛选');
      return;
    }
    final serverParent = _folderId == 'root' ? '' : _folderId;
    if (!rows.any((r) => r.parentId == serverParent)) {
      _snack('当前文件夹为空');
      return;
    }
    _exitSelect();
    setState(() {
      _reordering = true;
      _searchOpen = false;
      _tagFilter = '';
    });
  }

  Widget _reorderBarSlim(MdPalette p) {
    return Container(
      decoration: BoxDecoration(
        color: p.surface,
        border: Border(top: BorderSide(color: p.border)),
      ),
      padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
      child: Row(
        children: [
          Icon(Icons.swap_vert, size: 16, color: p.primary),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              _view == _ViewMode.grid
                  ? '拖动排序：长按卡片，拖到文件夹卡片移入'
                  : '拖动排序：长按拖动换序 · 拖到文件夹移入',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12, color: p.text2),
            ),
          ),
          TextButton(
            onPressed: () => setState(() {
              _reordering = false;
              _drag.end();
            }),
            child: const Text('完成'),
          ),
        ],
      ),
    );
  }

  Widget _iconBtn(MdPalette p, IconData icon, String tooltip,
      {bool active = false, required VoidCallback? onTap}) {
    return Material(
      color: active ? p.primarySoft : Colors.transparent,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: onTap,
        child: Tooltip(
          message: tooltip,
          child: Padding(
            padding: const EdgeInsets.all(8),
            child: Icon(icon,
                size: 20,
                color: active
                    ? p.primary
                    : onTap == null
                        ? p.text3
                        : p.text2),
          ),
        ),
      ),
    );
  }

  // ---- batch bar (web .batch-bar) ----

  Widget _batchBar(MdPalette p) {
    return Container(
      color: p.primarySoft,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      child: Row(
        children: [
          Text('已选 ${_selected.length} 项',
              style: TextStyle(fontSize: 13, color: p.primary, fontWeight: FontWeight.w600)),
          const Spacer(),
          _batchBtn(p, '打标签', _selected.isEmpty ? null : _batchTag),
          _batchBtn(p, '移动', _selected.isEmpty ? null : _batchMove),
          _batchBtn(p, '删除', _selected.isEmpty ? null : _batchDelete, danger: true),
        ],
      ),
    );
  }

  Widget _batchBtn(MdPalette p, String label, VoidCallback? onTap, {bool danger = false}) {
    return TextButton(
      onPressed: onTap,
      style: TextButton.styleFrom(
        foregroundColor: danger ? p.danger : p.primary,
        minimumSize: Size.zero,
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      ),
      child: Text(label, style: const TextStyle(fontSize: 12.5)),
    );
  }

  // ---- grid (web BookmarkGrid card) ----

  Widget _grid(MdPalette p, List<Node> children, List<Node> rows) {
    return GridView.builder(
      padding: const EdgeInsets.all(16),
      controller: _reordering ? _reorderScroll : null,
      gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
        maxCrossAxisExtent: 110,
        mainAxisExtent: 116,
        crossAxisSpacing: 10,
        mainAxisSpacing: 10,
      ),
      itemCount: children.length,
      itemBuilder: (context, i) {
        final n = children[i];
        final card = _card(p, n);
        if (!_reordering) return card;
        return ListenableBuilder(
          listenable: _drag,
          builder: (context, _) => DragTarget<String>(
            onWillAcceptWithDetails: (d) => canAcceptDrop(rows, d.data, n),
            onMove: (d) =>
                _drag.track(n, d.offset, grid: true, othersId: _app.driver.othersId),
            onLeave: (_) => _drag.clearHover(n.id),
            onAcceptWithDetails: (d) => _commitDrop(n, d.offset, rows, children),
            builder: (_, _, _) => KeyedSubtree(
              key: _drag.keyFor(n.id),
              child: LongPressDraggable<String>(
                data: n.id,
                dragAnchorStrategy: pointerDragAnchorStrategy,
                onDragStarted: () => _drag.start(n.id),
                onDragUpdate: (d) => _drag.autoScroll(d.globalPosition),
                onDragEnd: (_) => _drag.end(),
                onDraggableCanceled: (_, _) => _drag.end(),
                feedback: dragFeedback(context, p, n),
                childWhenDragging: Opacity(opacity: 0.3, child: card),
                child: card,
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _card(MdPalette p, Node n) {
    final isFolder = n.type == 'folder';
    final selected = _selected.contains(n.id);
    // 排序模式：落点分区可视化（左/右缘插入线、文件夹中心移入）
    final zone = _reordering && _drag.hoverId == n.id ? _drag.hoverZone : null;
    final inside = zone == DropZone.inside;
    BorderSide side(Color c, [double w = 1]) => BorderSide(color: c, width: w);
    Border border;
    if (zone == null) {
      border = Border.fromBorderSide(side(selected ? p.primary : p.border));
    } else if (zone == DropZone.before) {
      // 左缘插入线
      border = Border(left: side(p.primary, 4), top: side(p.primary, 1.5), right: side(p.border), bottom: side(p.border));
    } else if (zone == DropZone.after) {
      // 右缘插入线
      border = Border(left: side(p.border), top: side(p.border), right: side(p.primary, 4), bottom: side(p.border));
    } else {
      // 文件夹移入
      border = Border.fromBorderSide(side(p.primary, 2));
    }
    return Material(
      color: inside || (selected && !_reordering) ? p.primarySoft : p.surface,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: () {
          if (_reordering) {
            return; // 排序模式下不导航
          } else if (_selecting) {
            _toggle(n.id);
          } else if (isFolder) {
            setState(() => _folderId = n.id);
          } else {
            _open(n.url);
          }
        },
        onLongPress: _reordering
            ? null
            : () {
                setState(() {
                  _selecting = true;
                  _selected.add(n.id);
                });
              },
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            border: border,
          ),
          padding: const EdgeInsets.fromLTRB(8, 10, 8, 8),
          child: Stack(
            children: [
              Column(
                children: [
                  SizedBox(
                    height: 44,
                    child: Center(
                      child: isFolder
                          ? Container(
                              width: 40,
                              height: 40,
                              decoration: BoxDecoration(
                                color: p.primarySoft,
                                borderRadius: BorderRadius.circular(11),
                              ),
                              child: Icon(Icons.folder_rounded,
                                  size: 22, color: p.primary),
                            )
                          : BookmarkAvatar(url: n.url ?? '', title: n.title, size: 40),
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    n.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                        fontSize: 12, fontWeight: FontWeight.w600, color: p.text, height: 1.25),
                  ),
                  const Spacer(),
                  Text(
                    inside
                        ? '松手移入此文件夹'
                        : isFolder
                            ? '文件夹'
                            : _host(n.url),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                        fontSize: 10,
                        color: inside ? p.primary : p.text3,
                        fontWeight: inside ? FontWeight.w700 : FontWeight.w400),
                  ),
                ],
              ),
              if (n.favorite)
                Positioned(
                  top: 0,
                  right: 0,
                  child: Icon(Icons.star, size: 12, color: p.warning),
                ),
              if (_selecting && selected)
                Positioned(
                  top: 0,
                  left: 0,
                  child: Icon(Icons.check_circle, size: 14, color: p.primary),
                ),
              if (zone == DropZone.before || zone == DropZone.after)
                Positioned(
                  top: 2,
                  left: zone == DropZone.before ? 2 : null,
                  right: zone == DropZone.after ? 2 : null,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                    decoration: BoxDecoration(
                      color: p.primary,
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      zone == DropZone.before ? '← 放到它前面' : '放到它后面 →',
                      style: const TextStyle(
                          fontSize: 9, color: Colors.white, fontWeight: FontWeight.w700),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  // ---- list (web BookmarkList row) ----

  Widget _list(MdPalette p, List<Node> children, List<Node> rows) {
    if (_reordering) {
      return ListView.builder(
        controller: _reorderScroll,
        padding: const EdgeInsets.symmetric(vertical: 4),
        itemCount: children.length,
        itemBuilder: (context, i) {
          final n = children[i];
          return ListenableBuilder(
            listenable: _drag,
            builder: (context, _) {
              final showLine =
                  _drag.hoverId == n.id && _drag.hoverZone != DropZone.inside;
              final lineAbove = showLine && _drag.hoverZone == DropZone.before;
              return Column(
                children: [
                  if (lineAbove) dropLine(p),
                  DragTarget<String>(
                    onWillAcceptWithDetails: (d) => canAcceptDrop(rows, d.data, n),
                    onMove: (d) =>
                        _drag.track(n, d.offset, grid: false, othersId: _app.driver.othersId),
                    onLeave: (_) => _drag.clearHover(n.id),
                    onAcceptWithDetails: (d) => _commitDrop(n, d.offset, rows, children),
                    builder: (_, _, _) => KeyedSubtree(
                      key: _drag.keyFor(n.id),
                      child: LongPressDraggable<String>(
                        data: n.id,
                        dragAnchorStrategy: pointerDragAnchorStrategy,
                        onDragStarted: () => _drag.start(n.id),
                        onDragUpdate: (d) => _drag.autoScroll(d.globalPosition),
                        onDragEnd: (_) => _drag.end(),
                        onDraggableCanceled: (_, _) => _drag.end(),
                        feedback: dragFeedback(context, p, n),
                        childWhenDragging:
                            Opacity(opacity: 0.3, child: _listRowBody(p, n, reorder: true)),
                        child: _listRowBody(p, n, reorder: true),
                      ),
                    ),
                  ),
                  if (showLine && !lineAbove) dropLine(p),
                ],
              );
            },
          );
        },
      );
    }
    return ListView.separated(
      padding: const EdgeInsets.symmetric(vertical: 4),
      itemCount: children.length,
      separatorBuilder: (_, _) => Divider(height: 1, color: p.border, indent: 56),
      itemBuilder: (context, i) {
        final n = children[i];
        return InkWell(
          onTap: () {
            if (_selecting) {
              _toggle(n.id);
            } else if (n.type == 'folder') {
              setState(() => _folderId = n.id);
            } else {
              _open(n.url);
            }
          },
          onLongPress: () {
            setState(() {
              _selecting = true;
              _selected.add(n.id);
            });
          },
          child: _listRowBody(p, n),
        );
      },
    );
  }

  Widget _listRowBody(MdPalette p, Node n, {bool reorder = false}) {
    final isFolder = n.type == 'folder';
    final selected = _selected.contains(n.id);
    return Container(
      color: !reorder && selected ? p.primarySoft : p.surface,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Row(
        children: [
          SizedBox(
            width: 36,
            child: reorder
                ? Icon(Icons.drag_indicator, size: 18, color: p.text3)
                : _selecting
                    ? Checkbox(
                        value: selected,
                        onChanged: (_) => _toggle(n.id),
                        visualDensity: VisualDensity.compact,
                      )
                    : (isFolder
                        ? Container(
                            width: 32,
                            height: 32,
                            decoration: BoxDecoration(
                              color: p.primarySoft,
                              borderRadius: BorderRadius.circular(9),
                            ),
                            child: Icon(Icons.folder_rounded,
                                size: 18, color: p.primary),
                          )
                        : BookmarkAvatar(url: n.url ?? '', title: n.title, size: 32)),
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
                    if (n.note.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(left: 4),
                        child: Icon(Icons.sticky_note_2_outlined,
                            size: 13, color: p.text3),
                      ),
                  ],
                ),
                if (isFolder)
                  Text(reorder ? '文件夹 · 松手移入' : '文件夹',
                      style: TextStyle(
                          fontSize: 12,
                          color: reorder ? p.primary : p.text3))
                else
                  Text(n.url ?? '',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 12, color: p.text3)),
              ],
            ),
          ),
          if (reorder)
            Icon(Icons.drag_indicator, size: 18, color: p.text3)
          else if (isFolder)
            Icon(Icons.chevron_right, size: 18, color: p.text3)
          else if (!_selecting)
            PopupMenuButton<String>(
              icon: Icon(Icons.more_vert, size: 18, color: p.text3),
              onSelected: (v) => _rowAction(v, n),
              itemBuilder: (_) => const [
                PopupMenuItem(value: 'open', child: Text('打开')),
                PopupMenuItem(value: 'edit', child: Text('编辑')),
                PopupMenuItem(value: 'delete', child: Text('删除')),
              ],
            ),
        ],
      ),
    );
  }

  Widget _empty(MdPalette p) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 64,
            height: 64,
            decoration: BoxDecoration(
              color: p.primarySoft,
              borderRadius: BorderRadius.circular(18),
            ),
            child: Icon(Icons.bookmark_border, size: 30, color: p.primary),
          ),
          const SizedBox(height: 12),
          Text(
            _folderId == 'root' ? '还没有书签' : '这个文件夹是空的',
            style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600, color: p.text),
          ),
          const SizedBox(height: 4),
          Text(
            _folderId == 'root' ? '桌面端与插件中的书签会自动同步到这里' : '点「新书签」添加，或从其它设备同步',
            style: TextStyle(fontSize: 12, color: p.text3),
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }

  // ---- helpers ----

  /// 排序拖放的落点提交：文件夹中心带（含其他书签固定尾）= 移入；
  /// 其余 = 同级插行（序列排除 md-others，位置由服务端管理）
  void _commitDrop(Node target, Offset global, List<Node> rows, List<Node> children) {
    final dragged = _drag.dragId;
    final zone = _drag.hoverZone ?? DropZone.after;
    _drag.end();
    if (dragged == null) return;
    final othersId = _app.driver.othersId;
    if (zone == DropZone.inside && target.type == 'folder') {
      commitMoveInto(_app, rows, dragged, target.id);
    } else {
      final seq = List.of(children)..removeWhere((r) => r.id == othersId);
      if (!seq.any((r) => r.id == target.id)) return;
      commitReorderInsert(_app, _folderId, seq, dragged, target.id,
          before: zone == DropZone.before);
    }
  }

  String _host(String? url) {
    if (url == null || url.isEmpty) return '书签';
    try {
      return Uri.parse(url).host;
    } on FormatException {
      return '书签';
    }
  }

  void _toggle(String id) {
    setState(() {
      if (!_selected.remove(id)) _selected.add(id);
      if (_selected.isEmpty) _selecting = false;
    });
  }

  void _exitSelect() {
    setState(() {
      _selecting = false;
      _selected.clear();
    });
  }

  Future<void> _open(String? url) async {
    if (url == null || url.isEmpty) return;
    final uri = Uri.tryParse(url);
    if (uri == null) return;
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  Future<void> _rowAction(String action, Node n) async {
    switch (action) {
      case 'open':
        await _open(n.url);
      case 'edit':
        await showEditSheet(context, _db, existing: n);
      case 'delete':
        await _app.driver.journalTouch(n.id, removed: true);
        await (_db.delete(_db.nodes)..where((r) => r.id.equals(n.id))).go();
    }
  }

  Future<void> _pickTag(List<Node> rows) async {
    final counts = <String, int>{};
    for (final r in rows) {
      for (final t in tagsFromJson(r.tags)) {
        counts[t] = (counts[t] ?? 0) + 1;
      }
    }
    if (counts.isEmpty) {
      _snack('还没有任何标签');
      return;
    }
    final tags = counts.keys.toList()..sort();
    final chosen = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            ListTile(
              leading: const Icon(Icons.clear_all),
              title: const Text('全部标签'),
              onTap: () => Navigator.pop(ctx, ''),
            ),
            for (final t in tags)
              ListTile(
                leading: const Icon(Icons.label_outline),
                title: Text('$t (${counts[t]})'),
                onTap: () => Navigator.pop(ctx, t),
              ),
          ],
        ),
      ),
    );
    if (chosen != null) setState(() => _tagFilter = chosen);
  }

  Future<void> _batchDelete() async {
    final ids = _selected.toList();
    for (final id in ids) {
      await _app.driver.journalTouch(id, removed: true);
    }
    await (_db.delete(_db.nodes)..where((r) => r.id.isIn(ids))).go();
    _exitSelect();
  }

  Future<void> _batchMove() async {
    final target = await pickFolder(context, _db, excludeIds: _selected);
    if (target == null) return;
    final serverParent = target == 'root' ? '' : target;
    for (final id in _selected) {
      await (_db.update(_db.nodes)..where((r) => r.id.equals(id)))
          .write(NodesCompanion(parentId: Value(serverParent)));
      await _app.driver.journalTouch(id);
    }
    _exitSelect();
  }

  Future<void> _batchTag() async {
    final tags = await promptTags(context);
    if (tags == null) return;
    for (final id in _selected) {
      await (_db.update(_db.nodes)..where((r) => r.id.equals(id)))
          .write(NodesCompanion(tags: Value(tagsToJson(tags))));
      await _app.driver.journalTouch(id, tags: tags);
    }
    _exitSelect();
  }

  void _snack(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }
}
