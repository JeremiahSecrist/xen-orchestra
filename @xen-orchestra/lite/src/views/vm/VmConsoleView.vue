<template>
  <div :class="{ 'no-ui': !uiStore.hasUi }" class="vm-console-view">
    <UiSpinner v-if="!isReady" class="spinner" />
    <div v-else-if="!isVmRunning" class="not-running">
      <div><img alt="" src="@/assets/monitor.svg" /></div>
      {{ $t("power-on-for-console") }}
    </div>
    <template v-else-if="vm && vmConsole">
      <RemoteConsole
        :is-console-available="!isOperationsPending(vm, STOP_OPERATIONS)"
        :location="vmConsole.location"
        class="remote-console"
      />
      <div class="open-in-new-window">
        <RouterLink
          v-if="uiStore.hasUi"
          :to="{ query: { ui: '0' } }"
          class="link"
          target="_blank"
        >
          <UiIcon :icon="faArrowUpRightFromSquare" />
          {{ $t("open-in-new-window") }}
        </RouterLink>
      </div>
    </template>
  </div>
</template>

<script lang="ts" setup>
import RemoteConsole from "@/components/RemoteConsole.vue";
import UiIcon from "@/components/ui/icon/UiIcon.vue";
import UiSpinner from "@/components/ui/UiSpinner.vue";
import { isOperationsPending } from "@/libs/utils";
import { useConsoleStore } from "@/stores/console.store";
import { useUiStore } from "@/stores/ui.store";
import { useVmStore } from "@/stores/vm.store";
import { faArrowUpRightFromSquare } from "@fortawesome/free-solid-svg-icons";
import { computed } from "vue";
import { useRoute } from "vue-router";

const STOP_OPERATIONS = [
  "shutdown",
  "clean_shutdown",
  "hard_shutdown",
  "clean_reboot",
  "hard_reboot",
  "pause",
  "suspend",
];

const route = useRoute();
const uiStore = useUiStore();

const { isReady: isVmReady, getByUuid: getVmByUuid } = useVmStore().subscribe();

const { isReady: isConsoleReady, getByOpaqueRef: getConsoleByOpaqueRef } =
  useConsoleStore().subscribe();

const isReady = computed(() => isVmReady.value && isConsoleReady.value);

const vm = computed(() => getVmByUuid(route.params.uuid as string));

const isVmRunning = computed(() => vm.value?.power_state === "Running");

const vmConsole = computed(() => {
  const consoleOpaqueRef = vm.value?.consoles[0];

  if (consoleOpaqueRef === undefined) {
    return;
  }

  return getConsoleByOpaqueRef(consoleOpaqueRef);
});
</script>

<style lang="postcss" scoped>
.vm-console-view {
  display: flex;
  align-items: center;
  justify-content: center;
  height: calc(100% - 14.5rem);

  &.no-ui {
    height: 100%;
  }
}

.spinner {
  color: var(--color-extra-blue-base);
  display: flex;
  margin: auto;
  width: 10rem;
  height: 10rem;
}

.remote-console {
  flex: 1;
  max-width: 100%;
  height: 100%;
}

.not-running {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  text-align: center;
  gap: 4rem;
  color: var(--color-extra-blue-base);
  font-size: 3.6rem;
}

.open-in-new-window {
  position: absolute;
  top: 0;
  right: 0;
  overflow: hidden;

  & > .link {
    display: flex;
    align-items: center;
    gap: 1rem;
    background-color: var(--color-extra-blue-base);
    color: var(--color-blue-scale-500);
    text-decoration: none;
    padding: 1.5rem;
    font-size: 1.6rem;
    border-radius: 0 0 0 0.8rem;
    white-space: nowrap;
    transform: translateX(calc(100% - 4.5rem));
    transition: transform 0.2s ease-in-out;

    &:hover {
      transform: translateX(0);
    }
  }
}
</style>
