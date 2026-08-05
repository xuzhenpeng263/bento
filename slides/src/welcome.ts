// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The WebDeck authors
// Welcome page shown when the editor boots without an embedded document
// (static web deployment). Offers file-open, new-file, and drag-and-drop.

import { t } from './i18n'
import { openFilePicker, extractDocJson } from './save'
import { parseDoc, newDoc, type BentoDoc } from './model'

export interface WelcomeResult {
  doc: BentoDoc
  /** The file name this document was loaded from, if any. */
  openedAs?: string
  /** Whether we have a writable handle for the opened file. */
  writable: boolean
}

type Callback = (result: WelcomeResult) => void

/**
 * Render the welcome page over the splash. Returns a cleanup function.
 */
export function renderWelcome(onReady: Callback): () => void {
  // Dismiss the boot splash first — the welcome page replaces it
  const splash = document.getElementById('webdeck-splash')
  if (splash) {
    splash.classList.add('done')
    setTimeout(() => splash.remove(), 550)
  }

  const root = document.createElement('div')
  root.id = 'webdeck-welcome'
  root.innerHTML = `
    <div class="bw-card">
      <img class="bw-mark" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFAAAABACAYAAACNx/A2AAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqCAUFNhoOEINTAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTA4LTA1VDA1OjM2OjA0KzAwOjAwcAl9pwAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wOC0wNVQwNTozNDozMSswMDowMNkWPWIAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDgtMDVUMDU6NTQ6MjYrMDA6MDBvu+juAAAeUklEQVR42o18+Y8cR5beF1dmVlWf1d0kmzfFW6ROzwqaGc8vxsL2P2gD/g/WwA68xhr+2Z7dwQKzWGk0I1IakU1RB9kHye7q7qo849gf4kVkZnVxpCRIdlVnRUa8eMf3vveiWNM0DnQxxtA0DZzzb1lnYbSGA4BwF4v/0L/+B9a+imMtupi/2V/Onfm9Y2dGp18Ajv7AOfqoo7myznPDZ+ke+lx4nguD0Wecc/FvnBNj4JwhSRJIpaCkan/fEQUAyPCDsQaf/9tn2NvdRaISqDSBcw5lWcIY4/9qEycmhIAQHEIIMMbh4MAAWGvBOYez1v+O8ygQxgDGeNwczhgc/FhwDsYYqCSJwhdCRFFyIWCMBeCgtYYxGtb6hetGgwuBsGdaG2jdgDH/M2MMumn8whnAGY8i9J9vILiAdRaMMTDG4JzDYDCA1hrvvvcQ9+7fbyUXhMlIgJwx/PDjC/zxs8/wN598gpW1VaRJitlsBq01iqJA0zTQWsMaA+ccOBdgnIEzBmO9poYFwjlYmoAXMAPnHGmWYWNjjDRJgY6GJkmCuq79pkgJYww44wC8UDltgnWAEBzGGEipIKWApvkkSkEbg6aqMZvNIKSAEMJ/ljGUZQnGGOq6BmccZVVCSknjOhy9eQOVptja2kJd13DOochzHB0e4v/+4//B9vZFrK6utdpMqiiD3ud5jktXLmPr3Dk4OOzuvsTkaILhcAStGyyvrCBNU1hjYKzt2ZZ0gEsSMi0XTZhzDs45wLyB12WFP3/xJzx8/z2MlpbgrEM2GEA3DZI0hRACRmu/KUb7nzmHJX1RSsEY4+/lHNoYwDkkSQLdNCjLEvlsBqUSpGkKKQW4kCjLElmWoaoqKKWQz2Yo8gIqUVhbXcV0NsPe/j6UUhgMMggu8M+/+x0uXbqEm3duI/siw2w6xdraml9fx7vIoIpVVSFRiTeBpsHB/gHee/99HE8mKKsK129cx+bmVs8XzDm3rmvpOYumafDVo0e4cH0bDg6PvvwSn/7yV1CDBFp7nyulhKWNaZoGxmhwLmCdA3cMSarQNA2UUuCco9Ea1hpkaQZjDKqqisLLhhn5Wo6yLAEAdV0DDJieTiGFRFWVmEyOsLy8jMFggDRNUFVe86bTKdbW17G8sgIpJISU0Fp7q3EMXS8YfWDTNJjNZjg5PcHR4RGuXruGc+fP4+jwEMtLSxBCQBvd96ALL5JiJ1BYa7G6vgaVKNx/8C7+19//Fnt7e1haXoJuNKy1fm7OoWkaWOsgpfd5UgokSYrJZALnHJRS0FqjqRukaQLGGYyxyPMcSZLAAaiPazg41FUNAKhKb65lWYJzjmyQYXllGWmWYTqdQjcNRqMlrK5KnByfQgiOu/fugXGGWZ6jqRtY590T66ySBEhxyVq8efUKO0Jg++JFvPvgXUip8P6HH8A510ZVhk5Unle5NiA563zQ4BxCcFy+cgUMDIwz/Ke//Vs823mKVwfcm6qx5LgtOX0fQKx1EELA0fwcbYbWGowxCCG8HyN3oRJFc/VBTGu/OcaYaCBKSrhD5xEGBUZjDQVfH3mzLENd12CMkXaXFEDR94EAZJCDVAqf/urXuHv/Ht68eYMffviBhMBixOXklNfW1iGlBMB6wi2rEq/2DzCdTmMUFlLAORejtbUW1hicO3feL8Da9l5B/jL8BWu3iCFCF8Y4BPeR3xgL1xGGDbCEBO6sA+MkbCUJ1nhrtNaBMwbrHLIsw63bt+GsRVXXcM5CqQScc3y78wzGmL7q0Y8y4iQHSClxcnKCnSdPoXUDzjmWV1aQZRnGG2NvAoxjf38Ply9dxtMnT/D0yVMsLS/hk08/xc6Tp9i+uO21jnOUZYGqrLC2vo6TkxOsr6/g8M0bjDc2MJtOMd7YgFSq7wDe5mOdWwRFu+/07u2NRxvMOpsQbmPwAetPX3yBS5cvY3J0hN/9v/+PPM/x69/8R9y5d5c2z/WFR8+Q3Tk4OLx+9RpCCvzL7/8ZS0tLePjBBxgOh5gcTfBsZwcP33sPpyenqLdqHBwc4ObtWzg5PobHZw0GgwH29/axurqKovAYcjabYX93D1VR4nR6isFwiNlshvPb2xgOh35BjnVA7k9cBNzDxvcF2b7RB/Ou58G6wJ9zjiRJMZtOoclkBcEuOESY1n0UIwwr0XsEIKVAPpvh41/8BxRFCa01pqenGG9s4MqVK6iqivxNgtW1Nbx58wZ37txBmqZgjGMymWB5eRnHx8dIkgTLKyvQTYOV1RWkWQaHNqhYZ1FV1RnNY51/2vdbrQn397II0lDnbC9LcTFrOStUxhikFGBgsM5CSonhcIAL29vQjfbwSGvoponQLWxDG0RYHA0MwOWrV8AYw2w2g9EaZVmhaRocHR5BKQ9yr1y9CgeHu/fvQTeaIqPBlStX8fr1KwAeHHPOURQFGIDVtTVY57CcKHDB4ZzDm9evW4fUlQ7NJeyy97NeU+q6gSFA3wJ44yFQGMY6GGugGx0XzjmHlDLCoHBlWQqlFN555x2srq+BM47//F//C6z1WZgPJpw20gVjidcZDTyeHOP5t88hpfDYCQDnAkVR0EI9yGaMx5QnDM4ZB+M+UBhNk3fBifvJ+/SOQVKGEjNf5iM065hZ1D3rCBv6rMN2gs/8/P2QjNK0sC9+PkVRwIbIbH3k55SOSqnw+KvHsMZGuLT78iU+/dWvkGYppZs4426jAK0xYGCQUuLw8BBXr17FYDg8s2s+WgoopcA4BycI4T20dwFhMcZocMYhpH+MtSZG7765LiYDun6t7/z9a+csWjdI93QgaCtRf4emzKa7cXHzWN8/WudwPJlgOBggCfl538V2Ujl4EsBZ69OrNMG5c+cglPTpGGNgnEMKAU4CjAk/F+CCg4FBJSo+JOAopVQEyEH4C695OPkzYklHSj95jwNlONogy9LoHt42nG50XGcgRRbNS4JM2zthR4gbEFJ4wXV3iXOfWRjvbxSBWOdcxHtwQFEUHvFnGay1qKsKkrT4DEzpQvufLbRFkn5LHhmiNWi+8PNLksSD9LeiJtvm84wYJTd/jwNvX/gblJRQsl1s8BOKzDCYjpQy7orsCHI2m/WEV5YlJPm+t67/5wqPLX7zr328mzk4mmuSpCiKEnXdLB6SPiKEBEgD28AT+Mg5HGid1youOLgUHTbF+ztrbXTMXZ8okzYOzaZTKEqFgtmmaUo+kFga0og5L/jzBdcjSLsi5HP3U87pbHsr+UvOOYbDoQ8q1iJNU/R9rr+UUuT7WG+HzhKqDDFVCZFOKgXO/C6EaGrhNZSTNiVJEgeaTk+RJCmklKiqCqenJ2jIjzhrPZfcY5GD1pM46H9rbSc49DMKZz2VJIWElDK6BcYYnLWwrs2XASDLMqysrHjEwPu7wBjDcDhAWZYoq9Lj2CgeBue8MgWRuq6e92AMvbDWRDMEAMF9eDeUU3LGPAMtJRwckaJ+zOlsiiwbQCUKZVHgxYuX+OrRI4zHG5AUiBhthrXWa2QQonVRUAESBXYmAOkuieCshZQKSZp4PyYlGCmA0RqMcxjjYcvJyQlu3rqFa9euzhly+3+WZaibBnVd+2jbVfwQAzpRet5VyPCOJeKAMw84ueARqArpheBVGkjTDHmeQymJqqoxHAxJGx2ybIDZdAohBNbHYzRNHSPxcDREUZS4evVqfI9zghQ9nmhxFhFu6GYj0TWQlnH6X0mJvd09fPbZZ7h69So45zBWx3u7okiUzziqqkJKkCXiWxZKEWdrNJHSh/N0Eef+4UFgTV1RrYFBKRnxUp7n2NvdxdMnT5DP8rgYpSSywQAvXrzAdDrF8fExmroB4DHYYDhAWZTYefKUwK0BpRzePOE6ILhleQKzPQ/cbSfBb2sviOZflRV++P57CMYwGA6xNl7HjRs3sLS01HEN/gOSUERRlBgMBvGXgaeMAnwbDgRAKZZfk9YGKlGEgzz4TZIkDrbz9Cmcc7h1+xaUUl4I9LvLV650KCyvYZwhbkb3CtDIkO+LfrGbG3cpro42BEQQKnPt+63JP3jvIeAchJR4/u23GA1HWFlZIV/bkQWxUaGQFjcNLFrnIsjTYWP6hUkhfAQWUQMD7eSQz2aYnk7x8P33cO/+/bdTUB1d76ZYZ03Wa0xT176s2vGLZzKN+TFpvOjoYzBtBSqEwGg0wt7uHn788UfP+71lykmi0Oi2CEWzfWuZtqeBIb+VweclKvKEQZWLogAXgnbQRXbl7cLzu1vXFV4dvMLJyTHquqao36ZpRVGgqiroRiNU4zyUEuQng6Z0a8GU3HcKWWHFaZYiSVJsb297KLV9geojDgtl0bFQJRWMNPG1D1Qciy4Z99/ZWDcFY1AqgeC8RxoUReHrtoTlQj23yHNkg6yXYwYNYgA4Z5jNcnzxx8+xtraG09NTrKysYDKZYHNzE5PJMS5evAhFsMg5B2N0pO6D059jtlqhsU4+6xzAGRKVYGdnBwf7+3j/gw9QltWZHPhMgSMqt+s8l7KyORjUCpA5gG5kkcLw0dFnI0HzcggpkSQJmqYBFwIqSWCtxevXr7B98RIRCa3gGOd4/eoVvvvuO5RFiUZrSKlgjMXK6hqKssLK6iomk2NcuLiN8xcueG0mTDifuy+YfxTEvGvgVJH74vM/Qjc+kHHhmfK3ad/88L6I5iI11/8AZSLORZ47/pIz3r7FfFVLCIE0SWLapaREkii6j3UAsdc4ax0O9vbx8sWPcNbi1cE+nj97jq2tc1AqwdHhEXTT4PWr1wCAb77+C3ae7kAITrUTE7scOBdU4NFoGk2bw2LAYZxBcOqCoLYMgOG7588RonW3AGXtgm2Z00LnvE92AFkiW/ARBukXzj1LSDVPtoACCiXDFnfRpBnzpscYvt15huPJBPcfvIskSbH78iW2ts7haHIEqXyKd+/+PW8a5MuMMT5LcB1OkHngzUJk7VSVWt8b7a3FkvE1hxQSnHE8+eYbbJ07hyzLwDnHv/z+9/jx+++xdf4c3n3wEBcuXJjTrvYyVLhHjPwt7gzZU2QIwiAx94NveWBgkElyhhYPzpxzhrqq8fVXj6kItYzHXz7y9QQ4qEShqTWapkGWZVhbW4cQHMfHx8iyLNYduioQgTKRngHqdALsQtvrNgkJwTEcDSOJG7KptfV13L1/D5wLPP7yES5dvNSlbjtrbN9ZiDLoLRmm4f1vv7mGgUUmtgsmQ3REHNz3ymxtbcFa38tS5AW1gnieUddNOy5j+PGHH3Hu/HlsZZnPfbsFH8ZxenKK3d2XUErh2vVrABjyfIbn3z6Py7TGR/8Agq31DUsXtrexde4cmqbB5HiCP//pz3jw8AE451hdXfX+Wki8/PHFmTpvz5WRUmltfqI7iwWtsgSIbejyih1Q3kz8R71JKzDydQFyaN3AOofRaAnD4QgnJyf0YAupJDG7XsNWVn2vDZyf4OGbN2CM+VKn5CjKIoLhsGnGGOzuvmxru1FbvM/MBgMvpPV17+uMgZISaeqDXZplSJKUgLsvqJ8VSavcQWiGygC9IiDrCNABlAmElq/WJIzRlIn0B4+FdTjUdYU8n3neUCk0vIFudMwSKgLIjJN7YH2zqGtfIpVSYn08BhjQNDVOTo6xurYeNWF5eRmf/vKXMYsIfjIAaEfaOxwNI6M0GA4oJfMaJQSHNhqKqZYEXah/rbXEuTKAdZg0htDa4XywsKSBgUzVut931/U1ZVnCWg+GR0vLqOsa+SzvEaeMAUdHhzDGR9PolElrOGcUFS3yfIbR0jJmsxnsqUFF1cCmqVuTtRanp1M0VC5oGztb37e8suo7ugjcM05lCM5hjfFj1g0SlRAt15JVHcWidQbLXCxmqgsz4uo8VR/SFt00yAYZ+ILwba3FdDqFoT6W9fV1bG5uRjObf9y56QxCcPzw/Q8IS2aM4ehwEjsbptMpGOP44fvvUNU10iSFsRa6afy8CEooJeGcpRYRCwdLmiUAciNGG3DF4z2+VuPXEZpFGWfUFeF6guu6Bk4tIWCO/PScwbuogR5G+F1j8QE+UJyVPQPzHUsEemfTaWRvm6bpVcLSNI2siZKKNsAz0pPjCR4/eoQb79yA1hp5noMxoGk0lEpQlRXMYBgtwjlE6ORLDQzOeROzzmE4GCJNk+ivfZHMwFAHWEhJA4ZkRJwyNi8ZxDo0Z76JNECnOcBAfCC5psBKB/Da95r9Z9hItHIUZem7RNM0Mtp+gQJlWeHo8BBVVZPf9C6gKkvkeY6maVAUBabTGazxjUf7+/u4du06rDEoihKvDl5hvDHusTLeTD1yUEmCpdESssHAd1+5dlGhwzZANc5FW0QjpBHJ3Z4WtpwA58LTbQtcZlspAsgkWc/nLbJ9hpb6sc6hpAn6QhMDQ8vNhdpIXVdeqwVV9pzFaDTEBx9+iCRJcP78BQgpYY3B+niMLMuwPl4HZwwnpycYb4zBOcdgOGhLCTRRKQSSNO2rDzwWtM5F8iN0KQRixGjd6frqrtj719AEIKRYIIiQyrXPoz45R73Of+VijHrx2trDcDRCmqVwpfOpEk3Q01MWUinK8zmsM7jxzk0ftCj1O1tM7/fIgAF5kaMqKyRJAks9iIAv4IcO1MnRBKPRCOONDZ+7pykx7AKg2newkj5AniuLhswIDI40fZFaydgwGU3Yt070Szrz8mMUVS0YZ0jSFEmiIk0f7nHOdzxMZ7MIiRyxzk+ffoPP/+0zKCVx89YtcC6ok4FhMBxhbX3Nb4hzkEJiNBphNp1hb28XG+ONyAZxLqhR3GL35Usc7O/jzt27WN8Ye1dDTerxxECHkQlFI793bSoYlCmgEjB0KLu+VHqdCbGJcKHtdnaIAaPRMLZubG9vxx1Vqq3UeYhisLy8hMlw4LXE+QxiPB7jo48/9ouTwtcyOv7NwyiD0WjowS/NUUmFLMvw/fffwxiDa9euIRtkeLazA2MMLl+5TOmh97NFnpO2+iASGwAAwqUAonK1wnO2TW+D1i5ibWRoKAlNNRFE94xqPldkuHDxEl7u7sZE3ZhAQ/U1MJzjOJkco66qOPksy7C8vNSmhPAwylrjucDcp36wDnJNEUPOkec5dnZ2kKYJlpZX8c03fwHjHOPxGOfOn8fBwYEnI8BgtMZs6nFjmFPQvECG9DAJfcZXDoX/PciHUkG9p1+OcGAQSpfUt9ZSefEsU+Gsw82bN/H4ywJ//3f/0z/AWDS69mbrHE6ILDDGg+LJZIIPP/ooRujQ2RD8UUdtMRgOqZ7L2llR5Dw8fIPxeAxjDSZHhzGY1VWNo8MjzKYzsPOei5RSgTOOzc0tDIYDGMrTLQH7UEkMwtPaH61I0xTGmhgbAnHcFVzfhGly3TgdzMga7aPQnOgHgwwffPQRrt+4Aa0bhBoFYwxVXeMf/+F/487dO9h7uYemqTEaLSEbZNQ8bpEkKcbjjU5psv08Z/wMxeScw8rKCv7mk09IaIhUUyt7jitXrlCnATAcDrGxuYkrV69CqQR1VaMiK4g1X3q81hpaN0izziEgFkw4BMZ51+baLv1etQuBEhLQzqc/Uqo+vHGAFBwbmxtRf4MbKYoCo+EIt27fwebWFsqiwOGbQ5yenuL4eEJ1jrbri4XmnVDkdw5W67Y23GkLybKss4C2ChfYGOcc8jxHnucoyxJHxxM8+/YZbt++Q0HNY00PqbxiaKPRaI0sTb0ZGx1Hj211bnFQlZ15ULNQm4E4eCwFONR1TT0xLA4aSMVWq10MEsZajDe8cGcqgZQKX3/9Nf7Hf/vvdLAlg6TIzakpPQiAUd5a17U/jYS2LzHWPUDMt/EF+9PTUzhr0egGdVV798M5rl+/7rv3jSH4Y2NXljEGjdHQ1PIGAE1dQypJWmfRWVbXBONPsvsi5KihFhJUNhAETVP7TiveofwXVGb8uTh/1EoIgaosUZYFHr73MEZSTkcgQBgrLwrvLqh501KOFRs8hYj+0BiNugpFf38G5fPPP8f6+joYA8rQNJRlSJMEpycnvqlIcIyWlnDj5js4Pj6mPNvE5qKy9EfBOOPQ0DFVDRu7SIwyRlvKKjzT3/WJ/sew+03TwIXFz3tUuoQUGI996rW8sozJ0SGUUlgfj70mhYOKnENQ7Tn0OftkX1Mm5usYYSNC8TxgSikEVtfXMRot4R4VvYC2p4VROjegLtPQ0D4YDHFycuKzjVhML6BUEslZY2wMbiHBWLRayoVZdJZwvoPAoW+azrEYueraH8dSSmLRJYTAcDjEwf4BLmxv4/bduwCoI57aOKxzsWuru61dxe62wPVZ/JBuBiLB4uat25324L6XtM5ienqKZ0+fYnllGU1T+7UQoVuUOZRSkEKgaXQsaIUu1ngULc6zm4l0phjSFdlrhuzWKvzP4bxa8ItnD1tzXLt+HV98/jn+9Q9/iGfb8jzHeDxuT3HG5h3KaZWKpcdQB2EkrFAdA9VrnfPtbIILWqRBU+uonXBAoxuqMFrM8hxFnuPh+++hKAocHx/DaH9IUUlFBxCr2KVmYktey19GtDIPY0ILVyj3+cUttM74npKSDqXUSBLVO8QMOFy6dAmbW5vx7O9sluMffvtbXLhwAcPhEEmaQGsDKQU5/LaTP+DHADeCaXun7ogHdETK8g4xwKCkgtYNqqokS7FI0gSbm1s4f+G8bxCVEgd7+6jKCoKOP3iC2FIZw0ITb+icpdS2FV7XE0YY49lhCiack/zmi6XhPTql0/GLUvpswXUCz3A4jEm5I1bk2o1r2NjYhKYcNZh1t5DF6RxczwBC9A21G9qqUEgC2g6t4M8Z88dbB8MBuBBIlALnAk1d4+mTJ3j3wQNIpZDnOUV/Fs/ahbN3zjrU1GHWrdCF+cnuHMM8fSSU87Kbu9MP4fsGw7lfHusnLcTxCx4MBnjn5jv4y9d/wcVLU2RZ5ntOyEdZ0x6nCgWutuuqowABG5KWeMhk2lMGhNc48ZE+QGk6+e6Jh+PjY0gpcf/BuyjLAsaaeDoUoM4u6maI+LLTMRFwIcA6vTFwUbu6ZcsFnOoZQTLm/aI3mYY6ufr5s5ACv/7Nb/D40Zc42N8nesvFem1o0+V0bIKHIjsPXWK87ZGxbfuappNKXY0NbSWCjpIJ6nsMsCXLMvz6N7+JlL+krxkIAtNN47tcw8EeS6dAg1128mcZQkjgtDyl3pBpiIUAcvHl+wcDBxhMM37aOSRpgo9/8Yv4OgzZUn690NvP88/oftDws/MIV1HkYMxnL4zx2BoipcBsNovQpctC1XUdeYCAf3vHZ+eeKcPL0EwIMOSz3Kvt244mvPXy50WYdTFA9HpKiB+cF0r/FD07M2a7CT9zMx1QlAWccxhkA8KWvsI3GAxQlhXCeWCjvfYywFsQIZFweDtEYh3b8dp5MgA8akFgXZyLB6Z/crI9/qGfifjvQJj/Xpd+Qt6nLxYLrde491Zo0B+sKAoAiK26Whvk+QyKThAYo5GkWW/YoijR1DWMNhCco67qCPbDmlrBhZ4d1tZErLUoigIO8LwdWkYmAOl2pt1CAhmU7QaatgXEGgvGXPvtHZ0WPUaVaja3s4ukEwtAXerfdcyZonQZOsmIdLDWkuYNYazxp6akgtW+dU0KEY+l+WcA0+kMVVWhrprYPKWkApufnSMYE1KZIi9iwfqrx4990yRYROXhQ22lnhH84b0GxJAGBXjhy5gOrlvlj3Nw7f+xntOOy3i3P5q6GqzrfS4wxnVdQ2uNJE3j/bppvFthHEWe+2YBxlCHnkEqTQRKzlqLqix8Gx1nvsbcO63aCo/IBG/ng+EQz58/hzEaH378EUoCmYF5iRiLomD4/pTe4sId9qyznRcY5sbqtU+g3ZRWcJ2DsOHZ6Aep7ti8881KQsgeHLHWoqmblpkWgtbCY8WurmosLS2hLEs8ffIUGxsbc7SJ33AZ8NpHH3+Ek5MT/NPv/gm3bt+CFD60h8pZVwOioIyFtT4XddSvEswg9vnxttcv9sQ49IMLmXsQqD9xpDsZiM8KAk0GIDZMtsdX0bobgjkhAATBdJvmI1g2upPZePgW6tfPnj3DN19/AykF7ty724NLUbFms6kLCyjLCv/6hz/g5YsXYHDxWys8FmP0FSZh4qLFaqHKFTpEqX7R/cs6px4D0I2ag3ZfAphttarvHbuFp3g2hLUNRgGCBCDuOt2o3QbOrvl3G+bhEL80w4N6jmvXrmJ1bZXID3QECLDZbNYCCFJjY3T8uhDW9/o9hqTr5P/a9ZPog7XC6ZrxGa7RzQ+zYMD5e3q1jM7xibdOpVsj6GQiXV/deYDsTcd5cpMzPncAov3MIkpnAYt0ZnmdLt34eq4g1pucm5tXd8QuMJq/962ge35ukaqfGw9o827MzyOA//bdfwccgt7ZEyREpwAAAABJRU5ErkJggg==" width="80" height="80" alt="WebDeck">
      <h1 class="bw-word"><b>WebDeck</b></h1>
      <p class="bw-desc">${t('Presentations that live in one file — open one or start fresh.')}</p>
      <div class="bw-actions">
        <button class="bw-btn bw-btn-primary" id="bw-open">📂&nbsp; ${t('Open File')}</button>
        <button class="bw-btn" id="bw-new">✨&nbsp; ${t('New File…')}</button>
      </div>
      <p class="bw-hint">${t('Or drop a .webdeck.html or .webdeck.json file anywhere on this page.')}</p>
    </div>
  `
  document.body.appendChild(root)

  const openBtn = root.querySelector('#bw-open') as HTMLButtonElement
  const newBtn = root.querySelector('#bw-new') as HTMLButtonElement

  openBtn.addEventListener('click', () => void openAndBoot(root, onReady))
  newBtn.addEventListener('click', () => void newFileAndBoot(root, onReady))

  // Keyboard shortcut: Ctrl+O to open
  const onKey = (ev: KeyboardEvent) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'o') {
      ev.preventDefault()
      void openAndBoot(root, onReady)
    }
  }
  document.addEventListener('keydown', onKey)

  function cleanup(el: HTMLElement) {
    document.removeEventListener('keydown', onKey)
    el.remove()
  }

  return () => cleanup(root)
}

async function openAndBoot(root: HTMLElement, onReady: Callback) {
  const openBtn = root.querySelector('#bw-open') as HTMLButtonElement
  const hint = root.querySelector('.bw-hint') as HTMLElement

  openBtn.disabled = true
  openBtn.textContent = '⏳ ' + t('Opening…')

  try {
    const picked = await openFilePicker()
    if (!picked) {
      openBtn.disabled = false
      openBtn.innerHTML = '📂&nbsp; ' + t('Open File')
      return
    }

    const { content, name, handle } = picked
    const json = extractDocJson(content, name)
    if (!json) {
      if (hint) {
        hint.textContent = t('{name} doesn\'t contain a WebDeck document — try another file.', { name })
        hint.classList.add('bw-err')
      }
      openBtn.disabled = false
      openBtn.innerHTML = '📂&nbsp; ' + t('Open File')
      return
    }

    const doc = parseDoc(json)
    if (!doc) {
      if (hint) {
        hint.textContent = t('{name} isn\'t a valid WebDeck document.', { name })
        hint.classList.add('bw-err')
      }
      openBtn.disabled = false
      openBtn.innerHTML = '📂&nbsp; ' + t('Open File')
      return
    }

    root.remove()
    onReady({ doc, openedAs: name, writable: !!handle })
  } catch (err) {
    console.error('webdeck: open file failed', err)
    if (hint) {
      hint.textContent = t('Couldn\'t open that file — see console for details.')
      hint.classList.add('bw-err')
    }
    openBtn.disabled = false
    openBtn.innerHTML = '📂&nbsp; ' + t('Open File')
  }
}

/**
 * Create a new .webdeck.json file via the save picker, write an empty document
 * into it, and boot the editor with a writable handle from the start.
 *
 * In browsers without the File System Access API the file is downloaded
 * and the editor opens with a download-on-save fallback.
 */
async function newFileAndBoot(root: HTMLElement, onReady: Callback) {
  const newBtn = root.querySelector('#bw-new') as HTMLButtonElement
  const hint = root.querySelector('.bw-hint') as HTMLElement

  newBtn.disabled = true
  newBtn.textContent = '⏳ …'

  try {
    const doc = newDoc()
    const json = JSON.stringify(doc, null, 2)
    const base = (doc.title || 'Untitled').replace(/[^\w\d-]+/g, '_').replace(/^_+|_+$/g, '')
    const filename = `${base || 'Untitled'}.webdeck.json`
    // Dynamically import save functions to avoid a static dependency loop
    const { adoptFileHandle } = await import('./save')

    const hasFs = typeof (window as any).showSaveFilePicker === 'function'

    if (hasFs) {
      // File System Access API: create the file, get a writable handle
      let handle: any = null
      try {
        handle = await (window as any).showSaveFilePicker({
          suggestedName: filename,
          id: 'webdeck-new',
          types: [{ description: 'WebDeck JSON', accept: { 'application/json': ['.json'] } }],
        })
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          newBtn.disabled = false
          newBtn.innerHTML = '✨&nbsp; ' + t('New File…')
          return
        }
        throw err
      }

      // Write the initial document
      const writable = await handle.createWritable()
      await writable.write(new Blob([json], { type: 'application/json' }))
      await writable.close()

      adoptFileHandle(handle as any)
      root.remove()
      onReady({ doc, openedAs: handle.name, writable: true })
    } else {
      // Fallback: download the JSON file
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 5000)

      root.remove()
      onReady({ doc, writable: false })
    }
  } catch (err) {
    console.error('webdeck: new file failed', err)
    if (hint) {
      hint.textContent = t('Couldn\'t create that file — see console for details.')
      hint.classList.add('bw-err')
    }
    newBtn.disabled = false
    newBtn.innerHTML = '✨&nbsp; ' + t('New File…')
  }
}
