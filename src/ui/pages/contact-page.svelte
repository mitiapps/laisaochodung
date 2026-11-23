<script>
  import PageShell from '../layout/page-shell.svelte';
  import { SITE, mailtoHref } from '../../config/site.js';

  const href = mailtoHref(SITE.contactEmail);
</script>

<PageShell title="Liên hệ">
  <div class="space-y-4 text-slate-200" data-testid="page-contact">
    <p>Báo lỗi luật, lỗi chấm điểm, biển báo sai hoặc góp ý cho trò chơi qua thư điện tử.</p>
    {#if href}
      <a class="text-sky-300 underline" {href} data-testid="contact-link">{SITE.contactEmail}</a>
    {:else}
      <p class="text-slate-400" data-testid="contact-missing">Địa chỉ liên hệ chưa thiết lập.</p>
    {/if}
  </div>
</PageShell>
