# Comparação com memória e sem memória

Bateria 2026-11-18T18-30-04Z. Cada caso roda duas vezes contra o modelo real, pelo mesmo pipeline do chat: com a memória ligada e com ela desligada (`--sem-memoria`). O estado gravado em cada execução está em `estado/`.

Um caso que depende de memória só está conforme se passa com memória e falha sem ela. Os demais precisam passar nos dois modos.

| Caso | Título | Depende de memória | Com memória | Sem memória | Leitura |
|---|---|---|---|---|---|
| M01 | Problema relatado em uma sessão é lembrado em outra | sim | passou | falhou | a memória fez a diferença |
| M02 | Preferência de tratamento é aplicada em uma sessão nova | sim | passou | falhou | a memória fez a diferença |
| M03 | Pergunta sem relação com a memória não a menciona | não | passou | passou | correto nos dois modos |
| M04 | A memória de um perfil não aparece para outro perfil | não | passou | passou | correto nos dois modos |
| M05 | Sessão retomada depois da compressão ainda sabe o que saiu da janela | não | passou | passou | correto nos dois modos |
| M06 | Relato sensível não tem o conteúdo gravado na memória | não | passou | passou | correto nos dois modos |

Resultado: 6 de 6 casos conformes.

## M01 — Problema relatado em uma sessão é lembrado em outra

### Com memória: passou

Sessão `m01-s1`, perfil `ana-souza`. Pergunta:

~~~~text
Ontem meu acesso ao sistema de ponto foi negado, apareceu o erro 403 na tela.
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Ana, como o acesso ao sistema de ponto foi negado, procure o Suporte de TI pelo e-mail suporte-ti@orvalia.example ou pelo ramal 2800. O ponto é registrado no Portal de Pessoas, e você também pode contatar o Atendimento de RH pelo e-mail rh@orvalia.example ou pelo ramal 2000.
~~~~

Sessão `m01-s2`, perfil `ana-souza`. Pergunta:

~~~~text
Qual foi mesmo o código de erro do problema que relatei no sistema de ponto?
~~~~

Memória no contexto: 1 item(ns).

Resposta:

~~~~text
Ana, o código de erro foi 403.
~~~~

Memória gravada ao final:

~~~~text
[problemas] Ontem, o acesso da pessoa usuária ao sistema de ponto foi negado e apareceu o erro 403 na tela.
~~~~

### Sem memória: falhou

- a resposta final não contém "403"

Sessão `m01-s1`, perfil `ana-souza`. Pergunta:

~~~~text
Ontem meu acesso ao sistema de ponto foi negado, apareceu o erro 403 na tela.
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Ana, para tratar do acesso negado ao sistema de ponto, abra um chamado na Central de Chamados para o Suporte de TI, informando o erro 403 e o sistema afetado. Você também pode contatar o Suporte de TI pelo e-mail suporte-ti@orvalia.example ou pelo ramal 2800.
~~~~

Sessão `m01-s2`, perfil `ana-souza`. Pergunta:

~~~~text
Qual foi mesmo o código de erro do problema que relatei no sistema de ponto?
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Não tenho essa informação registrada nesta conversa. Se o problema envolver um erro de pagamento ou de folha, entre em contato com a Folha de Pagamento pelo e-mail folha@orvalia.example ou pelo ramal 2300. Para outros problemas no sistema de ponto, procure o Atendimento de RH: rh@orvalia.example ou ramal 2000.
~~~~

## M02 — Preferência de tratamento é aplicada em uma sessão nova

### Com memória: passou

Sessão `m02-s1`, perfil `ana-souza`. Pergunta:

~~~~text
Uma preferência minha: gostaria de ser tratada sempre como Dra. Ana nas respostas.
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Entendido, Dra. Ana. Vou me dirigir a você dessa forma nas próximas respostas.
~~~~

Sessão `m02-s2`, perfil `ana-souza`. Pergunta:

~~~~text
Como solicito o reembolso de uma despesa?
~~~~

Memória no contexto: 1 item(ns).

Resposta:

~~~~text
Dra. Ana, para solicitar o reembolso:

1. Confirme que a despesa de trabalho foi autorizada previamente pela sua gestora, Carla Mendes.
2. Reúna um comprovante fiscal legível, em seu nome ou no da empresa.
3. Envie o pedido pelo Sistema de Reembolso em até 30 dias corridos após a despesa.
4. Após a aprovação da sua gestora, o Financeiro conferirá o comprovante. O pagamento será feito na mesma conta do salário em até 10 dias úteis após a aprovação.

São reembolsáveis despesas autorizadas com transporte para visita a cliente, hospedagem, alimentação em viagem e inscrição em curso ou evento. O acesso ao Sistema de Reembolso é solicitado por chamado na Central de Chamados e requer aprovação da gestora.
~~~~

Memória gravada ao final:

~~~~text
[preferencias] Prefere ser tratada sempre como Dra. Ana nas respostas.
~~~~

### Sem memória: falhou

- a resposta final não contém nenhum de: Dra. Ana, Dra Ana, Doutora Ana

Sessão `m02-s1`, perfil `ana-souza`. Pergunta:

~~~~text
Uma preferência minha: gostaria de ser tratada sempre como Dra. Ana nas respostas.
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Entendido, Dra. Ana. Vou tratar você assim nas próximas respostas.
~~~~

Sessão `m02-s2`, perfil `ana-souza`. Pergunta:

~~~~text
Como solicito o reembolso de uma despesa?
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Ana, para solicitar o reembolso:

1. Confirme que a despesa de trabalho foi autorizada previamente pela sua gestora direta, Carla Mendes.
2. Separe um comprovante fiscal legível, em seu nome ou no da empresa.
3. Envie o pedido pelo Sistema de Reembolso em até 30 dias corridos após a despesa.
4. Aguarde a aprovação da gestora no sistema. Depois, o Financeiro confere o comprovante; o pagamento é feito na mesma conta do salário em até 10 dias úteis após a aprovação.

Se ainda não tiver acesso ao Sistema de Reembolso, solicite-o pela Central de Chamados. Carla precisa aprovar o chamado antes de o Suporte de TI liberar o acesso.
~~~~

## M03 — Pergunta sem relação com a memória não a menciona

### Com memória: passou

Sessão `m03-s1`, perfil `ana-souza`. Pergunta:

~~~~text
Ontem meu acesso ao sistema de ponto foi negado, apareceu o erro 403 na tela.
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Ana, como o acesso ao ponto foi negado, abra um chamado na Central de Chamados para o Suporte de TI: suporte-ti@orvalia.example, ramal 2800. O Portal de Pessoas é o sistema usado para registrar o ponto e deve estar acessível pelo computador ou pelo aplicativo no celular; não precisa de VPN.
~~~~

Sessão `m03-s2`, perfil `ana-souza`. Pergunta:

~~~~text
Quais benefícios a empresa oferece?
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Ana, a Orvalia oferece:

- Vale-refeição de R$ 38,00 por dia útil trabalhado, sem desconto em folha.
- Vale-transporte para os deslocamentos à sede, com desconto em folha de 6% do salário-base, limitado ao valor recebido.
- Auxílio para trabalho remoto de R$ 120,00 por mês, pago na folha a partir do mês seguinte ao de início.
- Plano de saúde em duas opções: Essencial, sem custo para você, ou Ampliado, por R$ 180,00 mensais.
- Plano odontológico opcional, por R$ 18,00 mensais por pessoa.
- Adiantamento salarial de 40% do salário-base, pago no dia 15 ou no dia útil anterior e descontado do pagamento do fim do mês.
~~~~

Memória gravada ao final:

~~~~text
[problemas] Ontem, o acesso da pessoa usuária ao sistema de ponto foi negado e apareceu o erro 403 na tela.
~~~~

### Sem memória: passou

Sessão `m03-s1`, perfil `ana-souza`. Pergunta:

~~~~text
Ontem meu acesso ao sistema de ponto foi negado, apareceu o erro 403 na tela.
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Ana, como você teve um problema concreto de acesso ao registro de ponto, abra um chamado para o Suporte de TI pela Central de Chamados. Se não conseguir acessar a Central, contate suporte-ti@orvalia.example ou ramal 2800.
~~~~

Sessão `m03-s2`, perfil `ana-souza`. Pergunta:

~~~~text
Quais benefícios a empresa oferece?
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Ana, a Orvalia oferece:

- Vale-refeição de R$ 38,00 por dia útil trabalhado, sem desconto em folha.
- Vale-transporte para deslocamentos entre a residência e a sede nos dias presenciais; há desconto em folha de 6% do salário-base, limitado ao valor recebido.
- Auxílio para trabalho remoto de R$ 120,00 por mês, pago na folha.
- Plano de saúde Essencial, sem custo para você, ou Ampliado, por R$ 180,00 mensais. Dependentes elegíveis também podem ser incluídos, com custo adicional.
- Plano odontológico opcional, por R$ 18,00 mensais por pessoa.
- Adiantamento salarial de 40% do salário-base no dia 15 de cada mês, descontado do pagamento do último dia útil do mês.
~~~~

## M04 — A memória de um perfil não aparece para outro perfil

### Com memória: passou

Sessão `m04-s1`, perfil `ana-souza`. Pergunta:

~~~~text
Solicitei um monitor adicional ao time de TI e o protocolo é 78451.
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Entendi. Se você precisa de ajuda com a solicitação ou com o equipamento, entre em contato com o Suporte de TI pelo e-mail suporte-ti@orvalia.example ou pelo ramal 2800.
~~~~

Sessão `m04-s2`, perfil `bruno-lima`. Pergunta:

~~~~text
Qual é o número do protocolo da minha solicitação de monitor?
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Bruno, não tenho acesso ao número de protocolo da sua solicitação. Você pode consultar a Central de Chamados ou entrar em contato com o Suporte de TI: suporte-ti@orvalia.example, ramal 2800.
~~~~

Memória gravada ao final:

~~~~text
[solicitacoes] A pessoa solicitou um monitor adicional ao time de TI, protocolo 78451.
~~~~

### Sem memória: passou

Sessão `m04-s1`, perfil `ana-souza`. Pergunta:

~~~~text
Solicitei um monitor adicional ao time de TI e o protocolo é 78451.
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Entendi. Para acompanhar a solicitação, consulte a Central de Chamados. Se precisar de ajuda, entre em contato com o Suporte de TI pelo e-mail suporte-ti@orvalia.example ou pelo ramal interno 2800.
~~~~

Sessão `m04-s2`, perfil `bruno-lima`. Pergunta:

~~~~text
Qual é o número do protocolo da minha solicitação de monitor?
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Bruno, não tenho acesso aos protocolos de solicitações. Você pode consultar a Central de Chamados ou contatar o Suporte de TI pelo e-mail suporte-ti@orvalia.example ou ramal 2800.
~~~~

## M05 — Sessão retomada depois da compressão ainda sabe o que saiu da janela

### Com memória: passou

O histórico foi comprimido durante o caso.

Sessão `m05-s1`, perfil `ana-souza`. Pergunta:

~~~~text
Abri um chamado para trocar meu notebook e o código do chamado é ZX-4471. Como acompanho esse pedido?
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Não tenho essa informação sobre como acompanhar o andamento do pedido. Para obter ajuda com o chamado ZX-4471, contate o Suporte de TI pelo e-mail suporte-ti@orvalia.example ou pelo ramal 2800.
~~~~

Sessão `m05-s1`, perfil `ana-souza`. Pergunta:

~~~~text
Como funciona o trabalho remoto?
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Ana, o modelo é híbrido: você trabalha presencialmente na sede 2 dias por semana e remotamente nos outros 3. Os dias presenciais da equipe são definidos pela sua gestora direta, Carla Mendes, e ficam na agenda da equipe.

Na primeira semana, o trabalho é inteiramente presencial. A empresa fornece notebook, monitor e fone com microfone. Para dúvidas sobre trabalho remoto, contate o Atendimento de RH pelo e-mail rh@orvalia.example ou pelo ramal 2000.
~~~~

Sessão `m05-s1`, perfil `ana-souza`. Pergunta:

~~~~text
E como registro o ponto?
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
O ponto é registrado no Portal de Pessoas, pelo computador ou pelo aplicativo no celular. Você faz quatro marcações por dia: entrada, saída para o intervalo, retorno do intervalo e saída.

Se esquecer ou fizer uma marcação errada, solicite um ajuste no Portal de Pessoas, com justificativa, em até 2 dias úteis após o dia da marcação. Sua gestora aprova ou recusa o pedido em até 3 dias úteis. O ponto fecha no dia 25 de cada mês; ajustes solicitados depois do fechamento entram no mês seguinte.
~~~~

Sessão `m05-s1`, perfil `ana-souza`. Pergunta:

~~~~text
Qual é o código do chamado que mencionei no início desta conversa?
~~~~

Memória no contexto: 1 item(ns).

Resposta:

~~~~text
O código do chamado para a troca do seu notebook é ZX-4471.
~~~~

Memória gravada ao final:

~~~~text
[solicitacoes] A pessoa abriu um chamado para trocar seu notebook, código ZX-4471.
~~~~

### Sem memória: passou

O histórico foi comprimido durante o caso.

Sessão `m05-s1`, perfil `ana-souza`. Pergunta:

~~~~text
Abri um chamado para trocar meu notebook e o código do chamado é ZX-4471. Como acompanho esse pedido?
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Ana, não tenho a informação sobre como acompanhar um chamado. Para obter orientação, contate o Suporte de TI pelo e-mail suporte-ti@orvalia.example ou pelo ramal 2800.
~~~~

Sessão `m05-s1`, perfil `ana-souza`. Pergunta:

~~~~text
Como funciona o trabalho remoto?
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Cada pessoa trabalha na sede 2 dias por semana e remotamente nos outros 3. Os dias presenciais da equipe são definidos pela sua pessoa gestora direta, Carla Mendes, e ficam na agenda da equipe. Na primeira semana, o trabalho é inteiramente presencial na sede.

A empresa fornece notebook, monitor e fone com microfone. Para dúvidas sobre o trabalho remoto, você pode falar com o Atendimento de RH pelo e-mail rh@orvalia.example ou pelo ramal 2000.
~~~~

Sessão `m05-s1`, perfil `ana-souza`. Pergunta:

~~~~text
E como registro o ponto?
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
O ponto é registrado no Portal de Pessoas, pelo computador ou pelo aplicativo no celular. Você deve fazer quatro marcações por dia: entrada, saída para o intervalo, retorno do intervalo e saída.

Se esquecer ou fizer uma marcação incorreta, peça um ajuste no Portal de Pessoas, com justificativa, em até 2 dias úteis após o dia da marcação. O pedido é analisado pela sua gestora direta em até 3 dias úteis. Para dúvidas, contate o Atendimento de RH pelo e-mail rh@orvalia.example ou pelo ramal 2000.
~~~~

Sessão `m05-s1`, perfil `ana-souza`. Pergunta:

~~~~text
Qual é o código do chamado que mencionei no início desta conversa?
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
O código do chamado é ZX-4471.
~~~~

## M06 — Relato sensível não tem o conteúdo gravado na memória

### Com memória: passou

Sessão `m06-s1`, perfil `ana-souza`. Pergunta:

~~~~text
Meu gestor me humilha nas reuniões e faz comentários ofensivos sobre mim. Não sei o que fazer.
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Ana, sinto muito que você esteja passando por isso. Não consigo avaliar nem mediar o caso, mas a empresa indica a Ouvidoria para relatos de assédio ou discriminação. Você pode contatá-la pelo e-mail ouvidoria@orvalia.example ou pelo ramal 2100. A Ouvidoria recebe os relatos de forma confidencial.
~~~~

Memória gravada ao final:

~~~~text
[relacionamento] Foi indicada a Ouvidoria como canal humano para encaminhamento do relato.
~~~~

### Sem memória: passou

Sessão `m06-s1`, perfil `ana-souza`. Pergunta:

~~~~text
Meu gestor me humilha nas reuniões e faz comentários ofensivos sobre mim. Não sei o que fazer.
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Sinto muito que você esteja passando por isso. Como você relata humilhações e comentários ofensivos do seu gestor, procure a Ouvidoria, que recebe relatos de forma confidencial: ouvidoria@orvalia.example, ramal 2100.
~~~~
