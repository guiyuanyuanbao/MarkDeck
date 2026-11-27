<script setup lang="ts">
// Settings shell: pill tab switching + the /settings#<tab> deep link. Each
// tab's state, polling timers and scoped styles live in its own component
// (settings/SettingsAccount|Devices|Network|Snapshots.vue).
import { ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { Icon } from '@/components/icons'
import SettingsAccount from './settings/SettingsAccount.vue'
import SettingsDevices from './settings/SettingsDevices.vue'
import SettingsNetwork from './settings/SettingsNetwork.vue'
import SettingsSnapshots from './settings/SettingsSnapshots.vue'

const tab = ref('account')
// deep-link: /settings#devices jumps straight to the pairing tab (the
// topbar's device icon routes here — pairing should never be buried)
function applyHashTab(h: string) {
  if (h === 'account' || h === 'devices' || h === 'network' || h === 'snapshots') tab.value = h
}
applyHashTab(location.hash.replace('#', ''))
// vue-router updates route.hash without a native hashchange event when the
// path stays the same — watch the route instead
const route = useRoute()
watch(() => route.hash, (h: string) => applyHashTab(h.replace('#', '')))
</script>
<template>
  <div class="page-shell">
    <div class="page-hero">
      <div class="page-hero-title">
        <h1 class="page-title">设置</h1>
        <span class="page-sub">账户安全、设备同步与数据备份</span>
      </div>
    </div>

    <div class="pill-tabs">
      <button class="pill-tab" :class="{ active: tab === 'account' }" @click="tab = 'account'">
        <Icon name="shield" :size="14" /> 账户
      </button>
      <button class="pill-tab" :class="{ active: tab === 'devices' }" @click="tab = 'devices'">
        <Icon name="laptop" :size="14" /> 设备同步
      </button>
      <button class="pill-tab" :class="{ active: tab === 'network' }" @click="tab = 'network'">
        <Icon name="link" :size="14" /> 网络代理
      </button>
      <button class="pill-tab" :class="{ active: tab === 'snapshots' }" @click="tab = 'snapshots'">
        <Icon name="restore" :size="14" /> 备份快照
      </button>
    </div>

    <SettingsAccount v-if="tab === 'account'" />
    <SettingsDevices v-else-if="tab === 'devices'" />
    <SettingsNetwork v-else-if="tab === 'network'" />
    <SettingsSnapshots v-else-if="tab === 'snapshots'" />
  </div>
</template>
