<script>
  import PageShell from '../layout/page-shell.svelte';
  import { pageHref } from '../lib/route.js';
</script>

<PageShell title="Không tìm thấy trang">
  <p data-testid="page-not-found">
    Trang này không tồn tại. <a class="text-police-700 underline hover:text-police-900" href={pageHref('home')}>Về trang chủ</a>
  </p>
</PageShell>
