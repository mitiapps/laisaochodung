<script>
  import PageShell from '../layout/page-shell.svelte';
  import { SITE, isHttpsUrl } from '../../config/site.js';

  const href = isHttpsUrl(SITE.donateUrl) ? SITE.donateUrl : null;
</script>

<PageShell title="Ủng hộ">
  <div class="space-y-4 text-slate-200" data-testid="page-donate">
    <p>Trò chơi miễn phí. Nếu thấy hữu ích, bạn có thể ủng hộ để duy trì và cập nhật luật mới.</p>
    {#if href}
      <a class="text-sky-300 underline" {href} target="_blank" rel="noopener noreferrer" data-testid="donate-link">Ủng hộ trò chơi</a>
    {:else}
      <p class="text-slate-400" data-testid="donate-missing">Kênh ủng hộ chưa thiết lập.</p>
    {/if}
  </div>
</PageShell>
