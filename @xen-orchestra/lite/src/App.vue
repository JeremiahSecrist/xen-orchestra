<template>
  <UnreachableHostsModal />
  <div v-if="!$route.meta.hasStoryNav && !xenApiStore.isConnected">
    <AppLogin />
  </div>
  <div v-else>
    <AppHeader />
    <div style="display: flex">
      <AppNavigation />
      <main class="main">
        <RouterView />
      </main>
    </div>
    <AppTooltips />
  </div>
</template>

<script lang="ts" setup>
import favicon from "@/assets/favicon.svg";
import AppHeader from "@/components/AppHeader.vue";
import AppLogin from "@/components/AppLogin.vue";
import AppNavigation from "@/components/AppNavigation.vue";
import AppTooltips from "@/components/AppTooltips.vue";
import UnreachableHostsModal from "@/components/UnreachableHostsModal.vue";
import { useChartTheme } from "@/composables/chart-theme.composable";
import { usePoolStore } from "@/stores/pool.store";
import { useUiStore } from "@/stores/ui.store";
import { useXenApiStore } from "@/stores/xen-api.store";
import { useActiveElement, useMagicKeys, whenever } from "@vueuse/core";
import { logicAnd } from "@vueuse/math";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

let link = document.querySelector(
  "link[rel~='icon']"
) as HTMLLinkElement | null;
if (link == null) {
  link = document.createElement("link");
  link.rel = "icon";
  document.getElementsByTagName("head")[0].appendChild(link);
}
link.href = favicon;

document.title = "XO Lite";

const xenApiStore = useXenApiStore();
const { pool } = usePoolStore().subscribe();
useChartTheme();
const uiStore = useUiStore();

if (import.meta.env.DEV) {
  const { locale } = useI18n();
  const activeElement = useActiveElement();
  const { D, L } = useMagicKeys();

  const canToggle = computed(() => {
    if (activeElement.value == null) {
      return true;
    }

    return !["INPUT", "TEXTAREA"].includes(activeElement.value.tagName);
  });

  whenever(
    logicAnd(D, canToggle),
    () => (uiStore.colorMode = uiStore.colorMode === "dark" ? "light" : "dark")
  );

  whenever(
    logicAnd(L, canToggle),
    () => (locale.value = locale.value === "en" ? "fr" : "en")
  );
}

whenever(
  () => pool.value?.$ref,
  async (poolRef) => {
    const xenApi = xenApiStore.getXapi();
    await xenApi.injectWatchEvent(poolRef);
    await xenApi.startWatch();
  }
);
</script>

<style lang="postcss">
@import "@/assets/base.css";
</style>

<style lang="postcss" scoped>
.main {
  overflow: auto;
  flex: 1;
  height: calc(100vh - 8rem);
  background-color: var(--background-color-secondary);
}
</style>
