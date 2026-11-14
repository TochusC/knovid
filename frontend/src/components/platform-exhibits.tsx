import { useState } from "react";
import { ArrowDown, ArrowUpRight, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import "./platform-exhibits.css";

const creationSteps = [
  {
    label: "想法与资料",
    title: "从你想讲的内容开始。",
    text: "一个知识点、一篇论文，或一段灵感。告诉知视，你想让谁听懂。",
    english: "THE IDEA",
  },
  {
    label: "脚本与画面",
    title: "让内容找到自己的表达。",
    text: "梳理讲解主线，组织旁白与分镜，让文字、图形和动画一起把知识讲清楚。",
    english: "THE STORY",
  },
  {
    label: "声音与成片",
    title: "看见作品，再把它打磨好。",
    text: "配音、字幕与画面连成一支视频。先看预览，再逐段调整内容和画面。",
    english: "THE FILM",
  },
];

function Slashes({ className = "" }: { className?: string }) {
  return (
    <span className={`platform-mini-slashes ${className}`} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

function ProcessSculpture({ step }: { step: number }) {
  return (
    <div className="process-sculpture" aria-hidden="true">
      <div className="process-sculpture-shadow" />
      <div className="process-slats">
        {creationSteps.map((item, index) => (
          <div
            className={`process-slat process-slat-${index} ${step === index ? "is-selected" : ""}`}
            key={item.label}
          >
            <div className="process-slat-edge" />
            <div className="process-slat-face">
              <span className="process-slat-number">0{index + 1}</span>
              {index === 0 && (
                <div className="process-paper">
                  <Slashes />
                  <b />
                  <b />
                  <b />
                  <span className="process-paper-rule" />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
              )}
              {index === 1 && (
                <div className="process-frames">
                  <div>
                    <i />
                    <i />
                    <i />
                  </div>
                  <div>
                    <span />
                    <span />
                  </div>
                  <em />
                  <em />
                  <em />
                </div>
              )}
              {index === 2 && (
                <div className="process-film">
                  <span>
                    <Play size={28} strokeWidth={1} fill="currentColor" />
                  </span>
                  <i />
                  <b />
                </div>
              )}
              <span className="process-slat-footer">{item.english}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="process-visual-caption">
        <Slashes />
        <span>三个阶段，一段完整的创作。</span>
      </div>
    </div>
  );
}

export function ProcessExhibit({
  active,
  quiet,
  onContinue,
  onDemo,
}: {
  active: boolean;
  quiet: boolean;
  onContinue: () => void;
  onDemo: () => void;
}) {
  const [step, setStep] = useState(0);
  return (
    <div
      className={`platform-exhibit process-exhibit ${active && !quiet ? "is-animating" : ""}`}
    >
      <div className="platform-story process-story">
        <div className="platform-eyebrow">
          <span>01 / 创作，从这里发生</span>
          <i />
        </div>
        <h2 id="landing-chapter-1">
          把想法，
          <br />
          变成一支<span>好视频。</span>
        </h2>
        <p className="platform-intro">
          从第一句想法，到最后一帧。
          <br />
          知视把创作的每一步，连在一起。
        </p>
        <div
          className="process-step-tabs"
          role="group"
          aria-label="了解视频创作流程"
        >
          {creationSteps.map((item, index) => (
            <button
              key={item.label}
              aria-pressed={step === index}
              onClick={() => setStep(index)}
            >
              <span>0{index + 1}</span>
              {item.label}
            </button>
          ))}
        </div>
        <div
          className="process-step-copy"
          aria-live="polite"
          aria-atomic="true"
        >
          <h3>{creationSteps[step].title}</h3>
          <p>{creationSteps[step].text}</p>
        </div>
        <div className="platform-story-actions">
          <button className="platform-text-action" onClick={onDemo}>
            <Play size={11} fill="currentColor" />
            看一支真实样片
            <ArrowUpRight size={14} />
          </button>
          <button className="platform-next-action" onClick={onContinue}>
            为什么是知视
            <ArrowDown size={15} />
          </button>
        </div>
      </div>
      <ProcessSculpture step={step} />
    </div>
  );
}

const platformBenefits = [
  {
    title: "为讲清楚而设计",
    text: "脚本、画面与旁白，围绕观众的理解展开。",
    tag: "知识优先",
  },
  {
    title: "每一处，都可以再打磨",
    text: "调整一句旁白、一个画面，逐段完善作品。",
    tag: "细节可控",
  },
  {
    title: "让 AI 团队分工协作",
    text: "连接内容、动效与声音，减少重复制作。",
    tag: "协同创作",
  },
];

export function PlatformExhibit({
  active,
  quiet,
  onEnter,
}: {
  active: boolean;
  quiet: boolean;
  onEnter: () => void;
}) {
  return (
    <div
      className={`platform-exhibit platform-belief ${active && !quiet ? "is-animating" : ""}`}
    >
      <div className="platform-brand-art" aria-hidden="true">
        <span className="platform-brand-halo" />
        <div className="platform-brand-volumes">
          {[0, 1, 2].map((index) => (
            <div
              className={`platform-brand-volume platform-brand-volume-${index}`}
              key={index}
            >
              <i />
              <b />
            </div>
          ))}
        </div>
        <div className="platform-brand-caption">
          <span>KnoVid</span>
          <i>让知识更好看，让创作更简单。</i>
        </div>
      </div>
      <div className="platform-story platform-belief-story">
        <div className="platform-eyebrow">
          <span>02 / 为知识创作者而生</span>
          <i />
        </div>
        <h2 id="landing-chapter-2">
          讲得清楚，
          <br />
          也改得<span>从容。</span>
        </h2>
        <p className="platform-intro">
          专注知识表达的 AI 视频创作平台。
          <br />
          把制作交给知视，把想法留在你手里。
        </p>
        <div className="platform-benefits">
          {platformBenefits.map((benefit, index) => (
            <div className="platform-benefit" key={benefit.title}>
              <span className="platform-benefit-index">0{index + 1}</span>
              <div>
                <h3>{benefit.title}</h3>
                <p>{benefit.text}</p>
              </div>
              <i>{benefit.tag}</i>
            </div>
          ))}
        </div>
        <div className="platform-create-row">
          <Button className="platform-create-button" onClick={onEnter}>
            <Slashes />
            <span>开始我的创作</span>
            <ArrowUpRight size={19} strokeWidth={1.5} />
          </Button>
          <p>
            无需注册即可体验
            <br />
            <span>3 次试用 · 每条 30 秒</span>
          </p>
        </div>
      </div>
    </div>
  );
}
