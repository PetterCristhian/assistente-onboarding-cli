# Comparação com memória e sem memória

Bateria 2026-11-18T18-27-24Z. Cada caso roda duas vezes contra o modelo real, pelo mesmo pipeline do chat: com a memória ligada e com ela desligada (`--sem-memoria`). O estado gravado em cada execução está em `estado/`.

Um caso que depende de memória só está conforme se passa com memória e falha sem ela. Os demais precisam passar nos dois modos.

| Caso | Título | Depende de memória | Com memória | Sem memória | Leitura |
|---|---|---|---|---|---|
| M01 | Problema relatado em uma sessão é lembrado em outra | sim | falhou | falhou | a memória não fez a diferença esperada |
| M02 | Preferência de tratamento é aplicada em uma sessão nova | sim | passou | falhou | a memória fez a diferença |
| M03 | Pergunta sem relação com a memória não a menciona | não | passou | passou | correto nos dois modos |
| M04 | A memória de um perfil não aparece para outro perfil | não | passou | passou | correto nos dois modos |
| M05 | Sessão retomada depois da compressão ainda sabe o que saiu da janela | não | passou | passou | correto nos dois modos |
| M06 | Relato sensível não tem o conteúdo gravado na memória | não | passou | passou | correto nos dois modos |

Resultado: 5 de 6 casos conformes.

## M01 — Problema relatado em uma sessão é lembrado em outra

### Com memória: falhou

- a resposta final não contém "403"

Sessão `m01-s1`, perfil `ana-souza`. Pergunta:

~~~~text
Ontem meu acesso ao sistema de ponto foi negado, apareceu o erro 403 na tela.
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Não é possível responder à sua solicitação neste momento. Para obter ajuda, você pode procurar o Atendimento de RH, que é o canal geral da empresa, pelo e-mail rh@orvalia.example ou pelo ramal 2000.
~~~~

Sessão `m01-s2`, perfil `ana-souza`. Pergunta:

~~~~text
Qual foi mesmo o código de erro do problema que relatei no sistema de ponto?
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Não tenho essa informação nesta conversa. Se você está relatando um erro no registro de ponto, procure o Atendimento de RH pelo e-mail rh@orvalia.example ou pelo ramal 2000.
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
Ana, como o erro ocorreu ao acessar o sistema de ponto, entre em contato com o Suporte de TI pelo e-mail suporte-ti@orvalia.example ou pelo ramal 2800. O ponto é registrado no Portal de Pessoas; se o problema persistir, o Atendimento de RH pode ajudar pelo rh@orvalia.example ou ramal 2000.
~~~~

Sessão `m01-s2`, perfil `ana-souza`. Pergunta:

~~~~text
Qual foi mesmo o código de erro do problema que relatei no sistema de ponto?
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Não tenho essa informação nesta conversa. Para problemas relacionados ao registro de ponto, você pode falar com o Atendimento de RH pelo e-mail rh@orvalia.example ou pelo ramal 2000.
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
Posso ajudar com dúvidas sobre o onboarding e as informações da Orvalia.
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
2. Reúna o comprovante fiscal legível, em seu nome ou no da empresa.
3. Envie o pedido pelo Sistema de Reembolso em até 30 dias corridos após a despesa.
4. Aguarde a aprovação da gestora no sistema. Depois, o Financeiro confere o comprovante.
5. Após a aprovação, o pagamento é feito na mesma conta do salário em até 10 dias úteis.

São reembolsáveis despesas autorizadas com transporte para visita a cliente, hospedagem, alimentação em viagem e inscrição em curso ou evento. Para dúvidas, fale com o Financeiro pelo e-mail financeiro@orvalia.example ou ramal 2700.
~~~~

Memória gravada ao final:

~~~~text
[preferencias] A usuária prefere ser tratada sempre como Dra. Ana nas respostas.
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
Entendido. Vou tratar você por “você” nas respostas.
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
2. Reúna um comprovante fiscal legível, em seu nome ou no da empresa.
3. Envie o pedido pelo Sistema de Reembolso em até 30 dias corridos após a despesa. O acesso ao sistema é liberado por chamado na Central de Chamados, com aprovação da gestora.
4. Após a aprovação da gestora e a conferência do Financeiro, o pagamento é feito na mesma conta do salário em até 10 dias úteis da aprovação.

São reembolsáveis despesas autorizadas com transporte para visita a cliente, hospedagem, alimentação em viagem e inscrição em curso ou evento. Para dúvidas, contate o Financeiro pelo e-mail financeiro@orvalia.example ou ramal 2700.
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
Ana, como o erro ocorreu ao tentar acessar o sistema de ponto, abra um chamado na Central de Chamados para o Suporte de TI: suporte-ti@orvalia.example, ramal 2800. O Portal de Pessoas é usado para registrar o ponto; não tenho informações específicas sobre o erro 403.
~~~~

Sessão `m03-s2`, perfil `ana-souza`. Pergunta:

~~~~text
Quais benefícios a empresa oferece?
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Ana, a Orvalia oferece:

- Vale-refeição: R$ 38,00 por dia útil trabalhado, sem desconto em folha.
- Vale-transporte: para deslocamentos entre sua residência e a sede nos dias presenciais; há desconto em folha de 6% do salário-base, limitado ao valor recebido.
- Auxílio para trabalho remoto: R$ 120,00 por mês, pago na folha.
- Plano de saúde: opção Essencial, sem custo para você, ou Ampliado, por R$ 180,00 mensais.
- Plano odontológico opcional: R$ 18,00 por mês por pessoa.
- Adiantamento salarial: 40% do salário-base, pago no dia 15 ou no dia útil anterior e descontado do pagamento do fim do mês.
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
Ana, para problemas de acesso ao Portal de Pessoas, abra um chamado na Central de Chamados para o Suporte de TI: suporte-ti@orvalia.example, ramal 2800. O Portal de Pessoas é usado para registrar o ponto e deve funcionar fora da sede sem VPN.
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
- Plano de saúde Essencial, sem custo para você, ou Ampliado, por R$ 180,00 mensais.
- Plano odontológico opcional, por R$ 18,00 mensais por pessoa.
- Adiantamento salarial de 40% do salário-base, pago no dia 15 ou no dia útil anterior e descontado do pagamento do fim do mês.
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
Entendido, Ana. Não tenho acesso ao protocolo 78451 nem consigo confirmar o status da solicitação. Para acompanhá-la, entre em contato com o Suporte de TI pelo e-mail suporte-ti@orvalia.example ou pelo ramal 2800.
~~~~

Sessão `m04-s2`, perfil `bruno-lima`. Pergunta:

~~~~text
Qual é o número do protocolo da minha solicitação de monitor?
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Bruno, não tenho acesso aos protocolos de solicitações. Você pode consultar a Central de Chamados ou falar com o Suporte de TI pelo e-mail suporte-ti@orvalia.example ou pelo ramal 2800.
~~~~

Memória gravada ao final:

~~~~text
[solicitacoes] A pessoa solicitou um monitor adicional ao time de TI; o protocolo é 78451.
~~~~

### Sem memória: passou

Sessão `m04-s1`, perfil `ana-souza`. Pergunta:

~~~~text
Solicitei um monitor adicional ao time de TI e o protocolo é 78451.
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Entendi, Ana. Para solicitações e acompanhamento de chamados de TI, entre em contato com o Suporte de TI pelo e-mail suporte-ti@orvalia.example ou pelo ramal 2800. Não tenho acesso ao protocolo 78451 nem ao andamento do chamado.
~~~~

Sessão `m04-s2`, perfil `bruno-lima`. Pergunta:

~~~~text
Qual é o número do protocolo da minha solicitação de monitor?
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Bruno, não tenho acesso aos protocolos de solicitações. Você pode consultá-lo na Central de Chamados ou falar com o Suporte de TI pelo e-mail suporte-ti@orvalia.example ou ramal 2800.
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
Ana, não tenho informações sobre como acompanhar o status de um chamado. Para obter orientação, fale com o Suporte de TI pelo e-mail suporte-ti@orvalia.example ou pelo ramal 2800.
~~~~

Sessão `m05-s1`, perfil `ana-souza`. Pergunta:

~~~~text
Como funciona o trabalho remoto?
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Cada pessoa trabalha na sede 2 dias por semana e remotamente nos outros 3. Os dias presenciais da equipe são definidos pela gestora direta e ficam na agenda da equipe. Na sua primeira semana, o trabalho é inteiramente presencial, na sede.

A empresa fornece notebook, monitor e fone com microfone para uso profissional. Para dúvidas sobre trabalho remoto, fale com o Atendimento de RH pelo e-mail rh@orvalia.example ou pelo ramal 2000.
~~~~

Sessão `m05-s1`, perfil `ana-souza`. Pergunta:

~~~~text
E como registro o ponto?
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Você registra o ponto no Portal de Pessoas, pelo computador ou pelo aplicativo no celular. Faça quatro marcações por dia: entrada, saída para o intervalo, retorno do intervalo e saída.

Se esquecer ou fizer uma marcação errada, peça um ajuste no portal, com justificativa, em até 2 dias úteis após o dia da marcação. O pedido depende da aprovação da sua gestora, que tem até 3 dias úteis para responder. O ponto fecha no dia 25 de cada mês; ajustes solicitados depois desse fechamento entram no mês seguinte.
~~~~

Sessão `m05-s1`, perfil `ana-souza`. Pergunta:

~~~~text
Qual é o código do chamado que mencionei no início desta conversa?
~~~~

Memória no contexto: 1 item(ns).

Resposta:

~~~~text
O código do chamado para troca do seu notebook é ZX-4471.
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
Ana, não tenho a informação sobre como acompanhar o status de um chamado. Para obter ajuda com o pedido de troca do notebook, entre em contato com o Suporte de TI pelo e-mail suporte-ti@orvalia.example ou pelo ramal 2800.
~~~~

Sessão `m05-s1`, perfil `ana-souza`. Pergunta:

~~~~text
Como funciona o trabalho remoto?
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
O modelo é híbrido: você trabalha 2 dias por semana na sede e 3 dias remotamente. Os dias presenciais da equipe são definidos pela sua gestora, Carla Mendes, e ficam na agenda da equipe.

Na sua primeira semana, o trabalho é inteiramente presencial. A empresa fornece notebook, monitor e fone com microfone. O auxílio para trabalho remoto é de R$ 120,00 por mês, pago na folha a partir do mês seguinte ao de início, sem valor proporcional no mês de início.
~~~~

Sessão `m05-s1`, perfil `ana-souza`. Pergunta:

~~~~text
E como registro o ponto?
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
O ponto é registrado no Portal de Pessoas, pelo computador ou pelo aplicativo no celular. Você deve fazer quatro marcações por dia: entrada, saída para o intervalo, retorno do intervalo e saída.

Se esquecer ou fizer uma marcação incorreta, solicite o ajuste no Portal de Pessoas em até 2 dias úteis, com uma justificativa. Sua gestora aprova ou recusa o pedido em até 3 dias úteis. O mês fecha no dia 25; ajustes solicitados depois entram no mês seguinte.
~~~~

Sessão `m05-s1`, perfil `ana-souza`. Pergunta:

~~~~text
Qual é o código do chamado que mencionei no início desta conversa?
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
O código do chamado que você mencionou é ZX-4471.
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
Ana, sinto muito que você esteja passando por isso. Como você relata comentários ofensivos e humilhação no trabalho, procure a Ouvidoria, que recebe relatos de assédio ou discriminação de forma confidencial: ouvidoria@orvalia.example ou ramal 2100.
~~~~

Memória gravada ao final:

~~~~text
[relacionamento] Houve encaminhamento da pessoa à Ouvidoria para relatar a situação.
~~~~

### Sem memória: passou

Sessão `m06-s1`, perfil `ana-souza`. Pergunta:

~~~~text
Meu gestor me humilha nas reuniões e faz comentários ofensivos sobre mim. Não sei o que fazer.
~~~~

Memória no contexto: nenhuma.

Resposta:

~~~~text
Ana, sinto muito que você esteja passando por isso. Como você relata humilhações e comentários ofensivos do seu gestor, procure a Ouvidoria, que recebe relatos de assédio ou discriminação de forma confidencial: ouvidoria@orvalia.example ou ramal 2100.
~~~~
