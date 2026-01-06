#include <vector>
#include <string>
#include <algorithm>
#include <cmath>
#include <limits>
#include <cstdio>
#include <sys/stat.h>

extern "C"
{
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/avutil.h>
#include <libavutil/opt.h>
#include <libavutil/channel_layout.h>
#include <libswresample/swresample.h>
}

#include <emscripten/bind.h>
#include <emscripten/val.h>

using namespace emscripten;

struct Status
{
    int status;
    std::string error;
};

struct AudioProperties
{
    Status status;
    std::string encoding;
    int sample_rate;
    int channels;
    double duration;
    std::map<std::string, std::string> metadata;
    std::vector<uint8_t> cover_art;
    int bits_per_sample;
};

struct ChunkResult
{
    Status status;
    emscripten::val samples;
    bool isEOF;
    double startTime;
};

std::string get_error_str(int status)
{
    char errbuf[AV_ERROR_MAX_STRING_SIZE];
    av_make_error_string(errbuf, AV_ERROR_MAX_STRING_SIZE, status);
    return std::string(errbuf);
}

struct AVFormatContextDeleter
{
    void operator()(AVFormatContext *ptr) const
    {
        if (ptr)
            avformat_close_input(&ptr);
    }
};

struct AVCodecContextDeleter
{
    void operator()(AVCodecContext *ptr) const
    {
        if (ptr)
            avcodec_free_context(&ptr);
    }
};

struct AVPacketDeleter
{
    void operator()(AVPacket *ptr) const
    {
        if (ptr)
            av_packet_free(&ptr);
    }
};

struct AVFrameDeleter
{
    void operator()(AVFrame *ptr) const
    {
        if (ptr)
            av_frame_free(&ptr);
    }
};

struct SwrContextDeleter
{
    void operator()(SwrContext *ptr) const
    {
        if (ptr)
            swr_free(&ptr);
    }
};

using FormatCtxPtr = std::unique_ptr<AVFormatContext, AVFormatContextDeleter>;
using CodecCtxPtr = std::unique_ptr<AVCodecContext, AVCodecContextDeleter>;
using PacketPtr = std::unique_ptr<AVPacket, AVPacketDeleter>;
using FramePtr = std::unique_ptr<AVFrame, AVFrameDeleter>;
using SwrCtxPtr = std::unique_ptr<SwrContext, SwrContextDeleter>;

class AudioSampleBuffer
{
private:
    uint8_t **m_data = nullptr;
    int m_linesize = 0;
    int m_channels = 0;
    int m_allocated_samples = 0;

public:
    AudioSampleBuffer() = default;

    ~AudioSampleBuffer()
    {
        reset();
    }

    AudioSampleBuffer(const AudioSampleBuffer &) = delete;
    AudioSampleBuffer &operator=(const AudioSampleBuffer &) = delete;

    void reset()
    {
        if (m_data)
        {
            av_freep(&m_data[0]);
            av_freep(&m_data);
        }
        m_data = nullptr;
        m_allocated_samples = 0;
    }

    uint8_t **grow(int channels, int required_samples)
    {
        if (required_samples > m_allocated_samples)
        {
            reset();
            int ret = av_samples_alloc_array_and_samples(
                &m_data, &m_linesize, channels, required_samples, AV_SAMPLE_FMT_FLTP, 0);
            if (ret < 0)
                return nullptr;
            m_allocated_samples = required_samples;
            m_channels = channels;
        }
        return m_data;
    }

    uint8_t **get() const { return m_data; }
    int linesize() const { return m_linesize; }
};

class AudioStreamDecoder
{
private:
    FormatCtxPtr format_ctx;
    CodecCtxPtr codec_ctx;
    PacketPtr packet;
    FramePtr frame;
    SwrCtxPtr swr_ctx;

    AudioSampleBuffer resample_buffer;

    int audio_stream_index = -1;
    bool initialized = false;

    std::vector<float> pcm_buffer;

    // 用于暂存每个通道的 Planar 数据
    std::vector<std::vector<float>> m_staging_buffers;
    // 用于最终输出的交错或拼接后的数据
    std::vector<float> m_pcm_output;

    // 下一帧预期的 PTS ，基于 time_base
    int64_t m_next_pts = AV_NOPTS_VALUE;
    // 当前流的时间基
    AVRational m_time_base = {1, 1};

public:
    AudioStreamDecoder() {}

    ~AudioStreamDecoder() = default;

    AudioProperties init(std::string path)
    {
        av_log_set_level(AV_LOG_ERROR);

        close();

        Status status = {0, ""};

        AVFormatContext *raw_fmt_ctx = nullptr;
        if ((status.status = avformat_open_input(&raw_fmt_ctx, path.c_str(), nullptr, nullptr)) != 0)
        {
            status.error = "avformat_open_input: " + get_error_str(status.status);
            return {status};
        }
        format_ctx.reset(raw_fmt_ctx);

        if ((status.status = avformat_find_stream_info(format_ctx.get(), nullptr)) < 0)
        {
            status.error = "avformat_find_stream_info: " + get_error_str(status.status);
            return {status};
        }

        const AVCodec *decoder;
        if ((audio_stream_index = av_find_best_stream(format_ctx.get(), AVMEDIA_TYPE_AUDIO, -1, -1, &decoder, -1)) < 0)
        {
            status.status = audio_stream_index;
            status.error = "av_find_best_stream: No audio stream found";
            return {status};
        }

        codec_ctx.reset(avcodec_alloc_context3(decoder));
        if (!codec_ctx)
        {
            status.status = -1;
            status.error = "Failed to alloc context";
            return {status};
        }

        avcodec_parameters_to_context(codec_ctx.get(), format_ctx->streams[audio_stream_index]->codecpar);

        if ((status.status = avcodec_open2(codec_ctx.get(), decoder, nullptr)) < 0)
        {
            status.error = "avcodec_open2: " + get_error_str(status.status);
            return {status};
        }

        swr_ctx.reset(swr_alloc());

        av_opt_set_chlayout(swr_ctx.get(), "in_chlayout", &codec_ctx->ch_layout, 0);
        av_opt_set_int(swr_ctx.get(), "in_sample_rate", codec_ctx->sample_rate, 0);
        av_opt_set_sample_fmt(swr_ctx.get(), "in_sample_fmt", codec_ctx->sample_fmt, 0);

        av_opt_set_chlayout(swr_ctx.get(), "out_chlayout", &codec_ctx->ch_layout, 0);
        av_opt_set_int(swr_ctx.get(), "out_sample_rate", codec_ctx->sample_rate, 0);
        av_opt_set_sample_fmt(swr_ctx.get(), "out_sample_fmt", AV_SAMPLE_FMT_FLTP, 0);

        if ((status.status = swr_init(swr_ctx.get())) < 0)
        {
            status.error = "Failed to initialize swresample context";
            return {status};
        }

        packet.reset(av_packet_alloc());
        frame.reset(av_frame_alloc());

        m_time_base = format_ctx->streams[audio_stream_index]->time_base;
        m_next_pts = AV_NOPTS_VALUE;

        initialized = true;

        std::map<std::string, std::string> meta_map;
        AVDictionaryEntry *tag = nullptr;

        while ((tag = av_dict_get(format_ctx->metadata, "", tag, AV_DICT_IGNORE_SUFFIX)))
        {
            meta_map[std::string(tag->key)] = std::string(tag->value);
        }

        tag = nullptr;
        if (audio_stream_index >= 0 && audio_stream_index < format_ctx->nb_streams)
        {
            AVDictionary *stream_meta = format_ctx->streams[audio_stream_index]->metadata;
            while ((tag = av_dict_get(stream_meta, "", tag, AV_DICT_IGNORE_SUFFIX)))
            {
                meta_map[std::string(tag->key)] = std::string(tag->value);
            }
        }

        std::vector<uint8_t> cover_data;

        for (int i = 0; i < format_ctx->nb_streams; i++)
        {
            AVStream *st = format_ctx->streams[i];
            if (st->disposition & AV_DISPOSITION_ATTACHED_PIC)
            {
                AVPacket pkt = st->attached_pic;
                if (pkt.size > 0)
                {
                    cover_data.assign(pkt.data, pkt.data + pkt.size);

                    break;
                }
            }
        }

        int bits = codec_ctx->bits_per_raw_sample;

        if (bits <= 0)
        {
            bits = av_get_bytes_per_sample(codec_ctx->sample_fmt) * 8;
        }

        return {
            {0, ""},
            avcodec_get_name(codec_ctx->codec_id),
            codec_ctx->sample_rate,
            codec_ctx->ch_layout.nb_channels,
            format_ctx->duration / static_cast<double>(AV_TIME_BASE),
            meta_map,
            cover_data,
            bits,
        };
    }

    ChunkResult readChunk(int chunkSize)
    {
        if (!initialized || !swr_ctx)
            return {
                {-1, "Decoder or SwrContext not initialized"},
                emscripten::val::undefined(),
                true,
            };

        ChunkResult result;
        result.status.status = 0;
        result.isEOF = false;
        result.startTime = -1.0;

        int output_channels = codec_ctx->ch_layout.nb_channels;

        if (m_staging_buffers.size() != static_cast<size_t>(output_channels))
        {
            m_staging_buffers.resize(output_channels);
        }

        for (auto &buf : m_staging_buffers)
        {
            buf.clear();
            buf.reserve(chunkSize);
        }

        int current_samples = 0;

        while (current_samples < chunkSize)
        {
            int receive_ret = avcodec_receive_frame(codec_ctx.get(), frame.get());

            if (receive_ret == 0)
            {

                // 获取当前帧的 PTS
                int64_t current_pts = frame->pts;
                if (current_pts == AV_NOPTS_VALUE)
                {
                    current_pts = frame->best_effort_timestamp;
                }

                // 如果当前帧有 PTS，强制更新内部时钟；否则沿用递推值
                if (current_pts != AV_NOPTS_VALUE)
                {
                    m_next_pts = current_pts;
                }

                // 如果是流的开头且没有 PTS，假定从 0 开始
                if (m_next_pts == AV_NOPTS_VALUE)
                {
                    m_next_pts = 0;
                }

                // 如果是本 Chunk 的第一帧数据，记录起始时间
                if (result.startTime < 0)
                {
                    result.startTime = m_next_pts * av_q2d(m_time_base);
                }

                // 计算当前帧持续时间并累加到 m_next_pts
                // 时长 = 样本数 / 采样率，需要转换到 m_time_base 单位
                if (frame->nb_samples > 0)
                {
                    int64_t duration = av_rescale_q(frame->nb_samples,
                                                    (AVRational){1, codec_ctx->sample_rate},
                                                    m_time_base);
                    m_next_pts += duration;
                }

                int dst_nb_samples = av_rescale_rnd(swr_get_delay(swr_ctx.get(), codec_ctx->sample_rate) + frame->nb_samples,
                                                    codec_ctx->sample_rate, codec_ctx->sample_rate, AV_ROUND_UP);

                uint8_t **out_data = resample_buffer.grow(output_channels, dst_nb_samples);
                if (!out_data)
                {
                    result.status = {-1, "Failed to allocate resample buffer"};
                    break;
                }

                int ret = swr_convert(swr_ctx.get(), out_data, dst_nb_samples,
                                      (const uint8_t **)frame->data, frame->nb_samples);

                if (ret < 0)
                {
                    result.status = {ret, "Swr convert error"};
                    break;
                }

                if (ret > 0)
                {
                    for (int ch = 0; ch < output_channels; ch++)
                    {
                        auto &ch_buf = m_staging_buffers[ch];
                        size_t old_size = ch_buf.size();
                        ch_buf.resize(old_size + ret);
                        memcpy(ch_buf.data() + old_size, out_data[ch], ret * sizeof(float));
                    }
                    current_samples += ret;
                }

                av_frame_unref(frame.get());
                continue;
            }
            else if (receive_ret == AVERROR_EOF)
            {
                int64_t delay = swr_get_delay(swr_ctx.get(), codec_ctx->sample_rate);
                if (delay > 0)
                {
                    int dst_nb_samples = av_rescale_rnd(delay, codec_ctx->sample_rate, codec_ctx->sample_rate, AV_ROUND_UP);
                    uint8_t **out_data = resample_buffer.grow(output_channels, dst_nb_samples);

                    if (out_data)
                    {
                        int ret = swr_convert(swr_ctx.get(), out_data, dst_nb_samples, nullptr, 0);
                        if (ret > 0)
                        {
                            for (int ch = 0; ch < output_channels; ch++)
                            {
                                auto &ch_buf = m_staging_buffers[ch];
                                size_t old_size = ch_buf.size();
                                ch_buf.resize(old_size + ret);
                                memcpy(ch_buf.data() + old_size, out_data[ch], ret * sizeof(float));
                            }
                            current_samples += ret;
                        }
                    }
                }
                result.isEOF = true;
                break;
            }
            else if (receive_ret != AVERROR(EAGAIN))
            {
                result.status = {receive_ret, "Receive frame error: " + get_error_str(receive_ret)};
                break;
            }

            int read_ret = av_read_frame(format_ctx.get(), packet.get());
            if (read_ret < 0)
            {
                if (read_ret == AVERROR_EOF)
                {
                    avcodec_send_packet(codec_ctx.get(), nullptr);
                    continue;
                }
                else
                {
                    result.status = {read_ret, "Read frame error: " + get_error_str(read_ret)};
                    break;
                }
            }

            if (packet->stream_index == audio_stream_index)
            {
                int send_ret = avcodec_send_packet(codec_ctx.get(), packet.get());
                if (send_ret < 0 && send_ret != AVERROR(EAGAIN) && send_ret != AVERROR_EOF)
                {
                    av_packet_unref(packet.get());
                    result.status = {send_ret, "Send packet error: " + get_error_str(send_ret)};
                    break;
                }
            }
            av_packet_unref(packet.get());
        }

        // 把数据打平成 AudioBuffer 声道需要的 LLL...RRR... Planer 格式
        int total_samples_all_channels = current_samples * output_channels;

        m_pcm_output.clear();
        m_pcm_output.resize(total_samples_all_channels);

        float *dst_ptr = m_pcm_output.data();

        for (int ch = 0; ch < output_channels; ch++)
        {
            size_t copy_count = m_staging_buffers[ch].size();
            memcpy(dst_ptr, m_staging_buffers[ch].data(), copy_count * sizeof(float));
            dst_ptr += copy_count;
        }

        result.samples = emscripten::val(
            emscripten::memory_view<float>(m_pcm_output.size(), m_pcm_output.data()));

        return result;
    }

    Status seek(double timestamp)
    {
        if (!initialized)
            return {-1, "Not initialized"};

        Status status = {0, ""};
        AVStream *stream = format_ctx->streams[audio_stream_index];

        int64_t target_ts = av_rescale_q(timestamp * AV_TIME_BASE, AV_TIME_BASE_Q, stream->time_base);

        if ((status.status = avformat_seek_file(format_ctx.get(), audio_stream_index, INT64_MIN, target_ts, target_ts, 0)) < 0)
        {
            status.error = "avformat_seek_file error: " + get_error_str(status.status);
            return status;
        }

        avcodec_flush_buffers(codec_ctx.get());

        // Seek 后重置预测时钟为 NOPTS，强制让下一帧的真实 PTS 来校准
        m_next_pts = AV_NOPTS_VALUE;

        return status;
    }

    void close()
    {
        packet.reset();
        frame.reset();
        swr_ctx.reset();
        codec_ctx.reset();
        format_ctx.reset();
        resample_buffer.reset();
        initialized = false;
        m_next_pts = AV_NOPTS_VALUE;

        for (auto &buf : m_staging_buffers)
        {
            std::vector<float>().swap(buf);
        }
        m_staging_buffers.clear();
        std::vector<float>().swap(m_pcm_output);
    }
};

EMSCRIPTEN_BINDINGS(my_module)
{
    value_object<Status>("Status")
        .field("status", &Status::status)
        .field("error", &Status::error);

    register_map<std::string, std::string>("StringMap");
    register_vector<std::string>("StringList");
    register_vector<uint8_t>("Uint8List");

    value_object<AudioProperties>("AudioProperties")
        .field("status", &AudioProperties::status)
        .field("encoding", &AudioProperties::encoding)
        .field("sampleRate", &AudioProperties::sample_rate)
        .field("channelCount", &AudioProperties::channels)
        .field("duration", &AudioProperties::duration)
        .field("metadata", &AudioProperties::metadata)
        .field("coverArt", &AudioProperties::cover_art)
        .field("bitsPerSample", &AudioProperties::bits_per_sample);

    value_object<ChunkResult>("ChunkResult")
        .field("status", &ChunkResult::status)
        .field("samples", &ChunkResult::samples)
        .field("isEOF", &ChunkResult::isEOF)
        .field("startTime", &ChunkResult::startTime);

    class_<AudioStreamDecoder>("AudioStreamDecoder")
        .constructor<>()
        .function("init", &AudioStreamDecoder::init)
        .function("readChunk", &AudioStreamDecoder::readChunk)
        .function("seek", &AudioStreamDecoder::seek)
        .function("close", &AudioStreamDecoder::close);
}
