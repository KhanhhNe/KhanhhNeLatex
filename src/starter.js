export const starterTitle = 'Untitled paper';
export const starter = String.raw`\documentclass[11pt]{article}
\usepackage{amsmath}
\usepackage[margin=1in]{geometry}

\title{A little room for big ideas}
\author{Your name}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
Every good paper starts with a thought.
This is a quiet place to give yours a little structure.
\end{abstract}

\section{The beginning}
Write freely. Compile when you are ready.
Your source stays in this browser until you choose
to save it to your account.

\section{A beautiful idea}
The Gaussian integral is
\begin{equation}
  \int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}.
\end{equation}

\section{Next steps}
\begin{itemize}
  \item Give this document a title.
  \item Make something worth sharing.
  \item Export your source or a finished PDF.
\end{itemize}

\end{document}
`;

export function skipDefault(document, accountDocuments) {
  // Unmarked drafts predate the first-visit marker; explicit new/imported drafts never qualify.
  return document.defaultDocument !== false && !document.owner && !document.cloudId
    && document.source === starter && document.title === starterTitle
    && accountDocuments.some(item => item.code !== document.code)
    && !accountDocuments.some(item => item.code === document.code);
}
