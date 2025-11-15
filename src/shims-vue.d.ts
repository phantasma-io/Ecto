import Vue from 'vue';
import VueRouter, { Route } from 'vue-router';
import { VueI18n } from 'vue-i18n';

declare module "*.vue" {
  export default Vue;
}

declare module 'vue/types/vue' {
  interface Vue {
    $router: VueRouter;
    $route: Route;
    $i18n: VueI18n;
  }
}
