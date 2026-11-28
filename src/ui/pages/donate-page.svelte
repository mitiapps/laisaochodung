<script>
  import PageShell from '../layout/page-shell.svelte';
  import { SITE, publicAssetUrl } from '../../config/site.js';

  const qr = SITE.donateQr;
</script>

<PageShell title="Ủng hộ">
  <div class="space-y-4 text-stone-800" data-testid="page-donate">
    <p>Trò chơi miễn phí. Nếu thấy hữu ích, bạn có thể ủng hộ để duy trì và cập nhật luật mới.</p>
    {#if qr}
      <p>Quét mã QR bằng ứng dụng ngân hàng hoặc ví điện tử bất kỳ:</p>
      <img class="mx-auto w-full max-w-xs rounded-lg" src={publicAssetUrl(qr.src, import.meta.env.BASE_URL)} alt={qr.alt} width="768" height="1024" data-testid="donate-qr" />
    {:else}
      <p class="text-stone-600" data-testid="donate-missing">Kênh ủng hộ chưa thiết lập.</p>
    {/if}
  </div>
</PageShell>
