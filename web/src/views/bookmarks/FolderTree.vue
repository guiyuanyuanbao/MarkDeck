<script setup lang="ts">
// Folder sidebar tree for BookmarksView. Renders the el-tree and forwards
// navigation, folder-DnD and the per-node context menu (menu items are built
// here but opened through the parent's shared ContextMenu instance).
import type { TreeNode } from '@/utils/ui'
import { Icon } from '@/components/icons'

defineProps<{
  tree: TreeNode[]
  dropHoverId: string | null
}>()

const emit = defineEmits<{
  (e: 'open-folder', id: string): void
  (e: 'create', folderId: string, type: 'url' | 'folder'): void
  (e: 'paste-into', folderId: string): void
  (e: 'node-drop', folderId: string, ev: DragEvent): void
  (e: 'hover', folderId: string | null): void
  (e: 'node-menu', folderId: string, ev: MouseEvent): void
}>()
</script>

<template>
  <div class="bm-side">
    <div class="panel-head">
      <span class="panel-title">文件夹</span>
      <button class="icon-btn" title="新建文件夹" @click="emit('create', '', 'folder')">＋</button>
    </div>
    <div class="tree-scroll">
      <el-tree
        :data="tree"
        node-key="id"
        :props="{ label: 'label', children: 'children', isLeaf: 'isLeaf' }"
        :expand-on-click-node="false"
        highlight-current
        @node-click="(n: TreeNode) => emit('open-folder', n.id)"
      >
        <template #default="{ data }">
          <span
            class="folder-node"
            :class="{ 'drop-target': dropHoverId === data.id }"
            @dragover.prevent="emit('hover', data.id)"
            @dragleave="dropHoverId === data.id && emit('hover', null)"
            @drop.prevent="emit('hover', null); emit('node-drop', data.id, $event)"
            @contextmenu.prevent.stop="emit('node-menu', data.id, $event)"
          >
            <span style="display:inline-flex;color:var(--md-warning)"><Icon name="folder" :size="15" /></span>
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ data.label }}</span>
          </span>
        </template>
      </el-tree>
    </div>
  </div>
</template>
