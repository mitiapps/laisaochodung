<script>
  import PageShell from '../layout/page-shell.svelte';
  import { formatDate, sourceLabel } from '../lib/format.js';
  import { loadSources } from '../lib/catalog.js';
  import { pageHref } from '../lib/route.js';

  const sources = loadSources().catch((/** @type {unknown} */ err) => {
    console.error('Failed to read the legal sources', err);
    throw err;
  });
</script>

<PageShell title="Giới thiệu và miễn trừ trách nhiệm">
  <div class="space-y-4 text-slate-200" data-testid="page-disclaimer">
    <p>
      “Lái sao cho đúng” là trò chơi mô phỏng giúp người lái làm quen với luật giao thông đường bộ Việt Nam.
      Các quy tắc được mô hình hóa từ văn bản pháp luật chính thức, nhưng cách chấm điểm có thể sai hoặc
      chưa đầy đủ.
    </p>
    <ul class="list-disc space-y-2 pl-6">
      <li>Kết quả trong trò chơi không phải tư vấn pháp lý và không thay thế văn bản pháp luật.</li>
      <li>
        Ngưỡng được đánh dấu <span class="rounded-full border border-amber-400/60 px-2 text-amber-200">ngưỡng của trò chơi</span>
        là ngưỡng do trò chơi tự đặt để phát hiện lỗi, không có trong văn bản.
      </li>
      <li>
        Mức phạt đánh dấu <span class="rounded-full border border-amber-400/60 px-2 text-amber-200">chưa kiểm chứng</span>
        chưa được đối chiếu với văn bản chính thức; điều khoản đánh dấu
        <span class="rounded-full border border-amber-400/60 px-2 text-amber-200">suy luận</span> được áp dụng theo suy luận.
      </li>
      <li>
        Bản đồ dựng từ dữ liệu OpenStreetMap là <strong>bản đồ mô phỏng</strong>: biển báo, vạch kẻ đường và đèn
        tín hiệu có thể khác ngoài thực tế.
      </li>
      <li>Tổng tiền phạt trên màn hình kết quả là ước tính, cộng khung phạt của từng lỗi.</li>
      <li>
        Nếu thấy sai sót, hãy báo qua trang <a class="text-sky-300 underline" href={pageHref('contact')}>Liên hệ</a>.
      </li>
    </ul>

    <h2 class="pt-4 text-xl font-semibold">Văn bản làm căn cứ</h2>
    {#await sources}
      <p class="text-slate-400">Đang tải danh sách văn bản…</p>
    {:then list}
      {#if list === null || list.length === 0}
        <p class="text-slate-400" data-testid="sources-missing">Chưa có dữ liệu văn bản trong bản dựng này.</p>
      {:else}
        <ul class="space-y-3" data-testid="sources">
          {#each list as source (source.id)}
            <li class="rounded-lg border border-slate-800 p-3">
              <p class="font-semibold">
                <a class="text-sky-300 underline" href={source.url} target="_blank" rel="noopener noreferrer">{sourceLabel(source.number)}</a>
              </p>
              <p class="text-sm text-slate-300">{source.title}</p>
              <p class="text-xs text-slate-400">
                Phiên bản: {source.edition}.
                Ngày ban hành: {formatDate(source.issued) ?? 'chưa ghi nhận'}.
                Hiệu lực từ: {formatDate(source.effectiveFrom) ?? 'chưa ghi nhận'}.
              </p>
            </li>
          {/each}
        </ul>
      {/if}
    {:catch}
      <p class="text-rose-300">Không đọc được danh sách văn bản.</p>
    {/await}
  </div>
</PageShell>
